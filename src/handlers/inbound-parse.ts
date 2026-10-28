/**
 * 入站消息解析
 *
 * 从 process-inbound 里抽出的「把一条 OneBot 消息变成模型可用文本」的逻辑：
 *   - 引用链展开（3 引用 2、2 引用 1 时一次性带全）
 *   - 引用机器人判定（quoteToBotReply）
 *   - 视频 / GIF 附件收集（交给宿主媒体理解管线）
 *   - 发送者展示名解析（昵称(qq: 数字)）
 *
 * `get_msg` 支持依赖注入，便于单测；生产环境默认走 connection.getMsg。
 */

import type { OneBotMessage } from "../types.js";
import {
    getRawText,
    getTextFromSegments,
    getReplyMessageId,
    getTextFromMessageContent,
} from "../message.js";
import { getQuoteChainDepth, getQuoteToBotReplyEnabled } from "../config.js";
import { buildQuoteChain, formatQuoteChain, quoteChainToText, quoteTargetIsSelf } from "../quote-chain.js";
import { getMsg, getStrangerInfo, getGroupMemberInfo } from "../connection.js";

/** 视频 / GIF 附件：交给 OpenClaw 的媒体理解管线（普通图片不传，避免额外成本） */
export interface InboundMediaFact {
    url: string;
    contentType?: string;
    kind: "video" | "image";
}

/** 解析后的入站消息 */
export interface ParsedInboundMessage {
    /** 模型看到的正文（含引用链） */
    messageText: string;
    /** 引用消息纯文本（没有引用时为空串），供智能触发判定使用 */
    quotedText: string;
    /** 是否直接引用了机器人自己的发言 */
    isQuoteToBot: boolean;
    /** 当前消息引用的消息 ID（无引用时为 undefined） */
    replyId: number | undefined;
    /** 视频 / GIF 附件 */
    mediaFacts: InboundMediaFact[];
}

export interface ParseInboundDeps {
    /** 取单条历史消息，默认 connection.getMsg；单测可注入假实现验证引用链/引用机器人直通 */
    getMsg?: (messageId: number) => Promise<unknown | null>;
}

const nicknameCache = new Map<string, { nickname: string; ts: number }>();
const NICKNAME_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟

/**
 * 解析发送者展示名称。
 * 优先使用消息体自带的群名片/昵称；若缺失，则通过 OneBot API 查询并缓存。
 * 最终格式为 nickname(qq: userId)，确保 AI 上下文中同时包含昵称与 ID。
 */
export async function resolveSenderNickname(
    userId: number,
    groupId: number | undefined,
    isGroup: boolean,
    senderFromMsg?: { nickname?: string; card?: string },
): Promise<string> {
    const card = senderFromMsg?.card?.trim();
    const nickname = senderFromMsg?.nickname?.trim();
    const base = card || nickname || "";
    if (base) {
        return `${base}(qq: ${userId})`;
    }

    const cacheKey = isGroup && groupId ? `group:${groupId}:${userId}` : `user:${userId}`;
    const cached = nicknameCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < NICKNAME_CACHE_TTL_MS) {
        return `${cached.nickname}(qq: ${userId})`;
    }

    let resolved = "";
    if (isGroup && groupId) {
        const info = await getGroupMemberInfo(groupId, userId);
        resolved = info?.card?.trim() || info?.nickname?.trim() || "";
    } else {
        const info = await getStrangerInfo(userId);
        resolved = info?.nickname?.trim() || "";
    }

    if (resolved) {
        nicknameCache.set(cacheKey, { nickname: resolved, ts: Date.now() });
        return `${resolved}(qq: ${userId})`;
    }

    return String(userId);
}

/**
 * 解析一条入站消息；空消息（既无文本也无媒体）返回 null，调用方直接丢弃。
 */
export async function parseInboundMessage(
    api: any,
    msg: OneBotMessage,
    selfId: number,
    deps: ParseInboundDeps = {},
): Promise<ParsedInboundMessage | null> {
    const replyId = getReplyMessageId(msg);
    let messageText: string;
    let quotedText = "";
    let isQuoteToBot = false;

    if (replyId != null) {
        const userText = getTextFromSegments(msg);
        try {
            // 引用链：3 引用 2、2 引用 1 时一次性把整条链带进上下文
            const chain = await buildQuoteChain({
                firstMessageId: replyId,
                fetchMessage: deps.getMsg ?? getMsg,
                maxDepth: getQuoteChainDepth(api.config),
            });
            if (chain.length > 0) {
                quotedText = chain.length > 1
                    ? quoteChainToText(chain)
                    : (chain[chain.length - 1]!.text ?? "");
                const chainBlock = formatQuoteChain(chain);
                messageText = userText ? `${chainBlock}\n${userText}` : chainBlock;
                isQuoteToBot = getQuoteToBotReplyEnabled(api.config) && quoteTargetIsSelf(chain, selfId);
                api.logger?.info?.(`[onebot] quote-chain replyId=${replyId} len=${chain.length} ids=${chain.map((e) => e.id).join(",")}${isQuoteToBot ? " to=self" : ""}`);
            } else {
                api.logger?.info?.(`[onebot] quote-chain replyId=${replyId} len=0 fallback=plain-text`);
                messageText = userText;
            }
        } catch {
            messageText = userText;
        }
    } else {
        // 文本 + 图片链接（去掉 [CQ:at,...] 等 CQ 码）：模型要能记录表情包、理解图片
        messageText =
            getTextFromMessageContent(msg.message).trim() ||
            getTextFromSegments(msg).trim() ||
            getRawText(msg);
    }

    // 视频 / GIF 附件：交给 OpenClaw 的媒体理解管线（仅含媒体时触发，
    // 例如 tools.media.models 配置的视频模型；普通图片仍只以文本链接形式出现，避免额外成本）
    const mediaFacts: InboundMediaFact[] = [];
    for (const seg of msg.message ?? []) {
        if (!seg || typeof seg !== "object") continue;
        const data = (seg.data ?? {}) as Record<string, unknown>;
        const rawUrl = (data.url ?? data.file) as unknown;
        if (typeof rawUrl !== "string" || !rawUrl) continue;
        if (seg.type === "video") {
            mediaFacts.push({ url: rawUrl, contentType: "video/mp4", kind: "video" });
        } else if (seg.type === "image" && /\.gif(?:\?|$)/i.test(rawUrl)) {
            mediaFacts.push({ url: rawUrl, contentType: "image/gif", kind: "image" });
        }
    }

    if (!messageText?.trim()) {
        if (mediaFacts.length === 0) {
            api.logger?.info?.(`[onebot] ignoring empty message`);
            return null;
        }
        messageText = mediaFacts.some((f) => f.kind === "video") ? "[视频]" : "[动图]";
    }

    return { messageText, quotedText, isQuoteToBot, replyId, mediaFacts };
}
