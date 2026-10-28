/**
 * 入站消息的 prompt 正文构建
 *
 * 从 process-inbound 里抽出的「模型实际看到的 Body」拼装逻辑：
 *   `[#消息ID] 昵称(qq: 数字)：正文` + 群历史 + 各能力提示（引用 / 表情包 / 沉默 / 吐槽 / @）。
 *
 * 历史上下文由宿主 SDK 的 buildPendingHistoryContextFromMap 负责，这里通过参数注入，
 * 便于单测，也避免把 session 存储耦合进来。
 */

import type { OneBotMessage } from "../types.js";
import type { SmartTriggerConfig } from "../config.js";
import type { JudgeIntent } from "../smart-trigger.js";
import {
    getQuoteEnabled,
    getStickerEnabled,
    getStickerContextLimit,
    getAtEnabled,
} from "../config.js";
import { buildStickerContext } from "../stickers.js";
import type { InboundMediaFact } from "./inbound-parse.js";
/** 群聊历史条目（与 process-inbound 的 sessionHistories 结构一致） */
export interface HistoryEntry {
    sender: string;
    body: string;
    timestamp: number;
    messageId: string;
}

export interface InboundBodyOptions {
    cfg: any;
    msg: OneBotMessage;
    /** 当前消息正文（已含引用链） */
    messageText: string;
    /** 发送者展示名（昵称(qq: 数字)） */
    fromLabel: string;
    isGroup: boolean;
    groupId?: number;
    sessionId: string;
    historyLimit: number;
    smart: SmartTriggerConfig;
    isAtMentioned: boolean;
    isQuoteToBot: boolean;
    smartReplyIntent?: JudgeIntent;
    historyMap: Map<string, HistoryEntry[]>;
    /** 宿主 SDK 的历史上下文构建函数；缺失时退化为只发当前消息 */
    buildPendingHistoryContextFromMap?: (args: {
        historyMap: Map<string, HistoryEntry[]>;
        historyKey: string;
        limit: number;
        currentMessage: string;
        formatEntry: (entry: HistoryEntry) => string;
    }) => string;
}

/** 历史条目统一为「[#id] 昵称(qq: 数字)：内容」，保证模型能区分发言人、也能引用 */
function formatHistoryEntry(entry: HistoryEntry): string {
    const id = entry?.messageId && !String(entry.messageId).startsWith("onebot-")
        ? `[#${entry.messageId}] `
        : "";
    return `${id}${entry.sender ?? "某人"}：${entry.body}`;
}

/**
 * 拼装交给模型的 Body：当前消息行 + 能力提示 + 群历史上下文。
 */
export function buildInboundBody(options: InboundBodyOptions): string {
    const {
        cfg,
        msg,
        messageText,
        fromLabel,
        isGroup,
        groupId,
        sessionId,
        historyLimit,
        smart,
        isAtMentioned,
        isQuoteToBot,
        smartReplyIntent,
        historyMap,
        buildPendingHistoryContextFromMap,
    } = options;

    const currentLine = msg.message_id != null
        ? `[#${msg.message_id}] ${fromLabel}：${messageText}`
        : `${fromLabel}：${messageText}`;

    const quoteHint = isGroup && getQuoteEnabled(cfg)
        ? "\n（需要引用某条消息时，在回复开头写 [[quote:消息ID]]，其中消息ID是上面 [#数字] 里的**纯数字**，例如 [[quote:1861270497]]；不要用 onebot- 开头的字符串。该标记不会发到群里。）"
        : "";
    const stickerBlock = isGroup && getStickerEnabled(cfg) ? buildStickerContext(getStickerContextLimit(cfg)) : "";
    const stickerHint = stickerBlock
        ? `\n【可用表情包】想发表情包时，调用 onebot_sticker_send（target=group:${groupId}，query 用下面的含义/标签关键词，也可传 stickerId）。库里有：\n${stickerBlock}`
        : "";
    // 智能触发放行（非 @ 消息）且开启 allowModelSilence 时，允许模型自主沉默。
    // 引用机器人属于明确对话，不能沉默。
    const silentHint = isGroup && smart.enabled && !isAtMentioned && !isQuoteToBot && smart.allowModelSilence
        ? `\n【接话判定】如果你判断此刻不适合接话，只输出 ${smart.silentMarker}，不要输出任何其他内容。`
        : "";
    // 判定器选择「吐槽接梗」时注入风格提示（sassStyle 非空则覆盖默认文案）
    const defaultSassHint = "【接话风格】这条消息适合吐槽接梗：用 1~2 句短句犀利吐槽或接梗，可以损但不要脏话、不要人身攻击、不要说教、不要长篇大论；拿不准就不必勉强。";
    const sassHint = isGroup && smart.enabled && smartReplyIntent === "sass"
        ? `\n${smart.sassStyle || defaultSassHint}`
        : "";
    // @ 说明：告诉模型标记语法与 QQ 号来源（历史行里的 qq: 数字 / 消息里的 @数字）
    const atHint = isGroup && getAtEnabled(cfg)
        ? "\n（需要 @ 群成员时，在回复里写 [[at:QQ号]]，QQ号取上下文里「昵称(qq: 数字)」的纯数字，例如 [[at:2384252941]]；不要写 [CQ:at,...] 这种 CQ 码，也不要留空 QQ 号。该标记会转成真正的 @。）"
        : "";
    const extraHint = `${quoteHint}${stickerHint}${silentHint}${sassHint}${atHint}`;

    return buildPendingHistoryContextFromMap
        ? buildPendingHistoryContextFromMap({
            historyMap,
            historyKey: sessionId,
            limit: historyLimit,
            currentMessage: `${currentLine}${extraHint}`,
            formatEntry: formatHistoryEntry,
        })
        : `${currentLine}${extraHint}`;
}

/** 媒体附件（视频 / GIF）描述；与 inbound-parse 的 InboundMediaFact 同构 */

export interface InboundEnvelopeOptions {
    /** 已拼好的 Body（含历史与能力提示） */
    body: string;
    /** 当前消息正文（不含历史） */
    messageText: string;
    isGroup: boolean;
    groupId?: number;
    userId: number;
    sessionId: string;
    accountId: string;
    fromLabel: string;
    messageId?: number;
    mediaFacts: InboundMediaFact[];
}

/**
 * 构建 dispatch 用的 ctxPayload（To / From / SessionKey / 媒体附件等）。
 * 回复目标约定：群聊 `onebot:group:群号`，私聊 `onebot:QQ号`。
 */
export function buildInboundEnvelope(options: InboundEnvelopeOptions): Record<string, unknown> {
    const {
        body,
        messageText,
        isGroup,
        groupId,
        userId,
        sessionId,
        accountId,
        fromLabel,
        messageId,
        mediaFacts,
    } = options;
    const replyTarget = isGroup ? `onebot:group:${groupId}` : `onebot:${userId}`;

    return {
        Body: body,
        RawBody: messageText,
        From: isGroup ? `onebot:group:${groupId}` : `onebot:${userId}`,
        To: replyTarget,
        SessionKey: sessionId,
        AccountId: accountId,
        ChatType: isGroup ? "group" : "direct",
        // 与 Feishu 一致：表示会话/回复目标，群聊时为 group:群号，非 SenderId
        ConversationLabel: replyTarget,
        SenderName: fromLabel,
        SenderId: String(userId),
        Provider: "onebot",
        Surface: "onebot",
        MessageSid: messageId != null ? String(messageId) : `onebot-${Date.now()}`,
        Timestamp: Date.now(),
        OriginatingChannel: "onebot",
        OriginatingTo: replyTarget,
        CommandAuthorized: true,
        DeliveryContext: {
            channel: "onebot",
            to: replyTarget,
            accountId,
        },
        // 视频 / GIF 作为媒体附件交给 OpenClaw 媒体理解（普通图片不传，避免额外成本）
        ...(mediaFacts.length > 0
            ? { media: mediaFacts.map((f) => ({ url: f.url, contentType: f.contentType, kind: f.kind })) }
            : {}),
        _onebot: { userId, groupId, isGroup },
    };
}
