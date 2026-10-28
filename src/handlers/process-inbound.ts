/**
 * 入站消息处理
 */

import type { OneBotMessage } from "../types.js";
import { getOneBotConfig } from "../config.js";
import {
    getTextFromSegments,
    isMentioned,
} from "../message.js";
import {
    getRenderMarkdownToPlain,
    getCollapseDoubleNewlines,
    getWhitelistUserIds,
    getBlacklistUserIds,
    getOgImageRenderTheme,
    getNormalModeFlushIntervalMs,
    getNormalModeFlushChars,
    getReplyWhenWhitelistDenied,
    getHistoryLimit,
    getQuoteEnabled,
    getAtEnabled,
    getSmartTriggerConfig,
} from "../config.js";
import type { JudgeIntent } from "../smart-trigger.js";
import { normalizeAtMarkers } from "../at.js";
import { markdownToPlain, collapseDoubleNewlines } from "../markdown.js";
import { markdownToImage } from "../og-image.js";
import {
    sendPrivateMsg,
    sendGroupMsg,
    sendPrivateImage,
    sendGroupImage,
    sendGroupForwardMsg,
    sendPrivateForwardMsg,
    setMsgEmojiLike,
} from "../connection.js";
import { setActiveReplyTarget, clearActiveReplyTarget, setActiveReplySessionId, setForwardSuppressDelivery, setActiveReplySelfId } from "../reply-context.js";
import { loadPluginSdk, getSdk } from "../sdk.js";
import { handleGroupIncrease } from "./group-increase.js";
import { decideGroupTrigger } from "./inbound-trigger.js";
import { buildInboundBody, buildInboundEnvelope } from "./inbound-prompt.js";
import { parseInboundMessage, resolveSenderNickname, type ParseInboundDeps } from "./inbound-parse.js";
import { markForwardPending, clearForwardPending } from "./inbound-forward.js";

// forward 模式的待处理会话与清理定时器见 inbound-forward.ts；
// 这里保留 re-export，避免改动 index.ts 的调用路径。
export { startForwardCleanupTimer } from "./inbound-forward.js";

/** 历史条目里单条消息的最大字符数，避免长消息把上下文撑爆 */
const HISTORY_ENTRY_MAX_CHARS = 500;
export const sessionHistories = new Map<string, Array<{ sender: string; body: string; timestamp: number; messageId: string }>>();

/** 每个 replySessionId 已发送的 chunk 数量，用于支持多次 final（如工具调用后追加内容） */
const lastSentChunkCountBySession = new Map<string, number>();

/** processInboundMessage 的可注入依赖（测试用；生产环境全部走默认实现） */
export type ProcessInboundDeps = ParseInboundDeps;

export async function processInboundMessage(api: any, msg: OneBotMessage, deps: ProcessInboundDeps = {}): Promise<void> {
    await loadPluginSdk();
    const { buildPendingHistoryContextFromMap, recordPendingHistoryEntry, clearHistoryEntriesIfEnabled } = getSdk();

    const runtime = api.runtime;
    if (!runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
        api.logger?.warn?.("[onebot] runtime.channel.reply not available");
        return;
    }

    const config = getOneBotConfig(api);
    if (!config) {
        api.logger?.warn?.("[onebot] not configured");
        return;
    }

    const selfId = msg.self_id ?? 0;
    if (msg.user_id != null && Number(msg.user_id) === Number(selfId)) {
        return;
    }

    // 解析正文 / 引用链 / 引用机器人标记 / 媒体附件（实现见 inbound-parse.ts）
    const parsed = await parseInboundMessage(api, msg, selfId, deps);
    if (!parsed) return;
    const { messageText, quotedText, isQuoteToBot, mediaFacts, replyId } = parsed;

    const isGroup = msg.message_type === "group";
    const cfg = api.config;
    const historyLimit = getHistoryLimit(cfg);

    // 会话信息提前解析：群聊历史记录与后续 dispatch 必须使用同一个 sessionId
    const userId = msg.user_id!;
    const groupId = msg.group_id;
    const tempSessionId = isGroup
        ? `onebot:group:${groupId}`.toLowerCase()
        : `onebot:${userId}`.toLowerCase();
    const peer = isGroup
        ? { kind: "group", id: String(groupId) }
        : { kind: "direct", id: String(userId) };
    const route = runtime.channel.routing?.resolveAgentRoute?.({
        cfg,
        sessionKey: tempSessionId,
        channel: "onebot",
        accountId: config.accountId ?? "default",
        peer,
    }) ?? { agentId: "main" };
    const sessionId = `agent:${route.agentId}:${tempSessionId}`;
    const storePath =
        runtime.channel.session?.resolveStorePath?.(cfg?.session?.store, {
            agentId: route.agentId,
        }) ?? "";
    const fromLabel = await resolveSenderNickname(Number(userId), groupId, isGroup, msg.sender);

    /**
     * 把一条群消息记入会话历史（包括不触发回复的消息）。
     * 这样下次被 @ / 命中关键词时，模型能看到之前群里聊了什么（参考 openclaw-feishu 的 pending history）。
     */
    const rememberMessage = (): void => {
        if (!recordPendingHistoryEntry || historyLimit <= 0) return;
        const body = messageText.length > HISTORY_ENTRY_MAX_CHARS
            ? `${messageText.slice(0, HISTORY_ENTRY_MAX_CHARS)}…`
            : messageText;
        recordPendingHistoryEntry({
            historyMap: sessionHistories,
            historyKey: sessionId,
            entry: {
                sender: fromLabel,
                body,
                timestamp: Date.now(),
                // 记录真实 OneBot 消息 id，供模型引用时使用
                messageId: msg.message_id != null ? String(msg.message_id) : `onebot-${Date.now()}`,
            },
            limit: historyLimit,
        });
    };

    // 智能触发配置：未显式开启 smartTrigger.enabled 时下面的分支完全走原逻辑
    const smart = getSmartTriggerConfig(cfg);
    const isAtMentioned = isGroup && isMentioned(msg, selfId);
    /** 智能触发放行后的接话方式：sass 时在 prompt 里注入吐槽风格提示 */
    let smartReplyIntent: JudgeIntent | undefined;

    // 触发检查逻辑（poke 等内部合成消息带 __onebotForceDispatch，直接跳过 @/关键词/LLM 判定）
    const forceDispatch = (msg as any).__onebotForceDispatch === true;
    if (isGroup && !forceDispatch) {
        // 判定链见 inbound-trigger.ts：@ → 引用机器人 → 智能触发两段式 → requireMention → 关键词。
        // skip 时判定模块内部已 rememberMessage，这里直接结束。
        const decision = await decideGroupTrigger({
            api,
            cfg,
            msg,
            groupId: Number(groupId),
            userId: Number(userId),
            selfId,
            messageText,
            quotedText,
            senderLabel: fromLabel,
            isAtMentioned,
            isQuoteToBot,
            smart,
            recentMessages: (limit) => {
                const entries = sessionHistories.get(sessionId) ?? [];
                return limit > 0
                    ? entries.slice(-limit).map((e) => ({ sender: e.sender, body: e.body }))
                    : [];
            },
            rememberMessage,
        });
        if (!decision.dispatch) return;
        smartReplyIntent = decision.smartReplyIntent;
    }

    const gi = (cfg?.channels?.onebot as Record<string, unknown>)?.groupIncrease as Record<string, unknown> | undefined;
    // 测试欢迎：@ 机器人并发送 /group-increase，模拟当前发送者入群，触发欢迎（使用该人的 id、nickname 等）
    // 使用 getTextFromSegments 提取纯文本，避免 raw_message 中 [CQ:at,qq=xxx] 等 CQ 码导致匹配失败
    const cmdText = getTextFromSegments(msg).trim() || messageText.trim();
    const groupIncreaseTrigger = isGroup && isMentioned(msg, selfId) && /^\/group-increase\s*$/i.test(cmdText) && gi?.enabled;
    if (groupIncreaseTrigger) {
        const fakeMsg = {
            post_type: "notice",
            notice_type: "group_increase",
            group_id: msg.group_id,
            user_id: msg.user_id,
        } as OneBotMessage;
        await handleGroupIncrease(api, fakeMsg);
        return;
    }

    // 白名单检查
    const whitelist = getWhitelistUserIds(cfg);
    if (whitelist.length > 0 && !whitelist.includes(Number(userId))) {
        if (getReplyWhenWhitelistDenied(cfg)) {
            const denyMsg = "权限不足，请向管理员申请权限";
            const getConfig = () => getOneBotConfig(api);
            try {
                if (msg.message_type === "group" && msg.group_id) await sendGroupMsg(msg.group_id, denyMsg, getConfig);
                else await sendPrivateMsg(userId, denyMsg, getConfig);
            } catch (_) { }
        }
        api.logger?.info?.(`[onebot] user ${userId} not in whitelist, denied`);
        return;
    }

    // 黑名单检查
    const blacklist = getBlacklistUserIds(cfg);
    if (blacklist.length > 0 && blacklist.includes(Number(userId))) {
        api.logger?.info?.(`[onebot] user ${userId} is in blacklist, ignored`);
        return;
    }

    // 引用机器人直通：确认已通过白/黑名单后再记日志，避免与权限拒绝日志顺序矛盾
    if (isGroup && isQuoteToBot) {
        api.logger?.info?.(`[onebot][smart] group=${groupId} decision=reply source=quote-to-bot replyId=${replyId} intent=answer`);
    }

    // 添加日志：打印插件接收到的原始消息内容
    api.logger?.info?.(`[onebot] received message from user ${userId}: "${messageText}"`);

    // 自己构造带昵称的正文：OpenClaw 的 formatInboundEnvelope 在部分版本不生效，
    // 会导致模型只看到裸文本（甚至带 CQ 码），无法区分谁说了什么。
    // 每条消息前带 [#消息ID]，模型回复时可用 [[quote:ID]] 引用对应消息。
    // 具体提示拼接见 inbound-prompt.ts。
    const body = buildInboundBody({
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
        historyMap: sessionHistories,
        buildPendingHistoryContextFromMap,
    });

    rememberMessage();

    // 回复目标（参考 openclaw-feishu）：群聊用 group:群号，私聊用 user:用户号
    // To / OriginatingTo / ConversationLabel 均表示「发送目标」，Agent 的 message 工具会据此选择 target
    const replyTarget = isGroup ? `onebot:group:${groupId}` : `onebot:${userId}`;
    const ctxPayload = buildInboundEnvelope({
        body,
        messageText,
        isGroup,
        groupId,
        userId,
        sessionId,
        accountId: config.accountId ?? "default",
        fromLabel,
        messageId: msg.message_id,
        mediaFacts,
    });

    if (runtime.channel.session?.recordInboundSession) {
        await runtime.channel.session.recordInboundSession({
            storePath,
            sessionKey: sessionId,
            ctx: ctxPayload,
            updateLastRoute: !isGroup ? { sessionKey: sessionId, channel: "onebot", to: String(userId), accountId: config.accountId ?? "default" } : undefined,
            onRecordError: (err: any) => api.logger?.warn?.(`[onebot] recordInboundSession: ${err}`),
        });
    }

    if (runtime.channel.activity?.record) {
        runtime.channel.activity.record({ channel: "onebot", accountId: config.accountId ?? "default", direction: "inbound" });
    }

    const onebotCfg = (cfg?.channels?.onebot as Record<string, unknown>) ?? {};
    const thinkingEmojiId = (onebotCfg.thinkingEmojiId as number) ?? 60;
    const userMessageId = msg.message_id;

    let emojiAdded = false;
    const clearEmojiReaction = async () => {
        if (emojiAdded && userMessageId != null) {
            try {
                await setMsgEmojiLike(userMessageId, thinkingEmojiId, false);
            } catch { }
            emojiAdded = false;
        }
    };

    if (userMessageId != null) {
        try {
            await setMsgEmojiLike(userMessageId, thinkingEmojiId, true);
            emojiAdded = true;
        } catch {
            api.logger?.warn?.("[onebot] setMsgEmojiLike failed (maybe OneBot doesn't support it)");
        }
    }

    const traceId = `trace-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const traceLog = {
        info: (m: string) => api.logger?.info?.(`[${traceId}] ${m}`),
        warn: (m: string) => api.logger?.warn?.(`[${traceId}] ${m}`),
        error: (m: string) => api.logger?.error?.(`[${traceId}] ${m}`)
    };

    traceLog.info(`dispatching message for session ${sessionId}`);

    const longMessageMode = (onebotCfg.longMessageMode as "normal" | "og_image" | "forward") ?? "normal";
    const longMessageThreshold = (onebotCfg.longMessageThreshold as number) ?? 300;
    traceLog.info(`longMessageMode=${longMessageMode}, threshold=${longMessageThreshold}`);
    const normalModeFlushIntervalMs = getNormalModeFlushIntervalMs(cfg);
    const normalModeFlushChars = getNormalModeFlushChars(cfg);

    const replySessionId = `onebot-reply-${Date.now()}-${sessionId}`;
    setActiveReplyTarget(replyTarget);
    setActiveReplySessionId(replySessionId);
    setActiveReplySelfId(selfId);
    if (longMessageMode === "forward") setForwardSuppressDelivery(true);

    const deliveredChunks: Array<{ index: number; text?: string; rawText?: string; mediaUrl?: string }> = [];
    let chunkIndex = 0;
    let normalModeBufferedText = "";
    let normalModeBufferedRawText = "";
    let normalModeFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let normalModeFlushChain: Promise<void> = Promise.resolve();
    let receivedFinal = false;
    /** 模型在回复里用 [[quote:ID]] 指定的引用目标，由下一块实际发送时消费 */
    let pendingQuoteId: string | undefined;

    const getConfig = () => getOneBotConfig(api);

    const onReplySessionEnd = onebotCfg.onReplySessionEnd as string | ((ctx: ReplySessionContext) => void | Promise<void>) | undefined;
    const normalModePunctuationFlushMinChars = 24;

    const clearNormalModeFlushTimer = (reason: string = "unknown") => {
        if (normalModeFlushTimer) {
            traceLog.info(`clearNormalModeFlushTimer: clearing timer, reason=${reason}`);
            clearTimeout(normalModeFlushTimer);
            normalModeFlushTimer = null;
        }
    };

    const hasBufferedNormalModeText = () => normalModeBufferedText.length > 0 || normalModeBufferedRawText.length > 0;

    const queueNormalModeFlush = (action: () => Promise<void>): Promise<void> => {
        normalModeFlushChain = normalModeFlushChain
            .then(action)
            .catch((e: any) => {
                traceLog.error(`normal-mode flush failed: ${e?.message ?? e}`);
            });
        return normalModeFlushChain;
    };

    const doSendChunk = async (
        effectiveIsGroup: boolean,
        effectiveGroupId: number | undefined,
        uid: number | undefined,
        text: string,
        mediaUrl: string | undefined
    ) => {
        // 引用只对本轮第一条真正发出的文本生效
        const quoteTo = pendingQuoteId;
        if (text) {
            if (effectiveIsGroup && effectiveGroupId) await sendGroupMsg(effectiveGroupId, text, getConfig, quoteTo);
            else if (uid) await sendPrivateMsg(uid, text, getConfig, quoteTo);
            if (quoteTo != null) pendingQuoteId = undefined;
        }
        if (mediaUrl) {
            if (effectiveIsGroup && effectiveGroupId) await sendGroupImage(effectiveGroupId, mediaUrl, api.logger, getConfig);
            else if (uid) await sendPrivateImage(uid, mediaUrl, api.logger, getConfig);
        }
    };

    const flushBufferedNormalModeText = async (
        effectiveIsGroup: boolean,
        effectiveGroupId: number | undefined,
        uid: number | undefined
    ): Promise<void> => {
        clearNormalModeFlushTimer("flushBufferedNormalModeText");
        if (!hasBufferedNormalModeText()) return;

        const text = normalModeBufferedText;
        const rawText = normalModeBufferedRawText;
        traceLog.info(`flushBufferedNormalModeText: textLen=${text.length}, textPreview="${text.slice(0, 30).replace(/\n/g, '\\n')}"`);
        normalModeBufferedText = "";
        normalModeBufferedRawText = "";

        await doSendChunk(effectiveIsGroup, effectiveGroupId, uid, text, undefined);
        deliveredChunks.push({
            index: chunkIndex++,
            text: text || undefined,
            rawText: rawText || undefined,
        });
    };

    const scheduleNormalModeFlush = (
        effectiveIsGroup: boolean,
        effectiveGroupId: number | undefined,
        uid: number | undefined
    ) => {
        if (normalModeFlushTimer) return;
        traceLog.info(`scheduleNormalModeFlush: scheduled (interval=${normalModeFlushIntervalMs}ms)`);
        normalModeFlushTimer = setTimeout(() => {
            traceLog.info(`scheduleNormalModeFlush: timer triggered`);
            void queueNormalModeFlush(() => flushBufferedNormalModeText(effectiveIsGroup, effectiveGroupId, uid));
        }, normalModeFlushIntervalMs);
    };

    const shouldFlushNormalModeBuffer = (): boolean => {
        const rawText = normalModeBufferedRawText || normalModeBufferedText;
        if (!rawText) return false;
        if (normalModeBufferedText.length >= normalModeFlushChars) return true;
        if (rawText.length < normalModePunctuationFlushMinChars) return false;
        return /[.!?。！？]\s*$/.test(rawText);
    };

    const appendNormalModeText = (current: string, next: string): string => {
        if (!current) return next;
        if (!next) return current;

        const lastChar = current[current.length - 1];
        const firstChar = next[0];
        if (/[A-Za-z0-9]/.test(lastChar) && /[A-Za-z0-9]/.test(firstChar)) {
            return `${current} ${next}`;
        }
        return `${current}${next}`;
    };

    try {
        await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
                deliver: async (payload: unknown, info: { kind: string }) => {
                    await clearEmojiReaction();

                    const p = payload as { text?: string; body?: string; mediaUrl?: string; mediaUrls?: string[] } | string;
                    const replyText = typeof p === "string" ? p : (p?.text ?? p?.body ?? "");
                    const mediaUrl = typeof p === "string" ? undefined : (p?.mediaUrl ?? p?.mediaUrls?.[0]);
                    const trimmed = (replyText || "").trim();

                    traceLog.info(`deliver entry: kind=${info.kind}, textLen=${replyText.length}, mediaUrl=${!!mediaUrl}, deliveredChunks=${deliveredChunks.length}`);

                    if (info.kind === "final") {
                        receivedFinal = true;
                    }

                    // 智能触发的沉默标记：整条回复即为标记时直接丢弃，绝不发到群里
                    const isSilentReply = smart.enabled && trimmed === smart.silentMarker;
                    if ((!trimmed || trimmed === "NO_REPLY" || trimmed.endsWith("NO_REPLY") || isSilentReply) && !mediaUrl) return;

                    const { userId: uid, groupId: gid, isGroup: ig } = (ctxPayload as any)._onebot || {};
                    const sessionKey = String((ctxPayload as any).SessionKey ?? sessionId);
                    const groupMatch = sessionKey.match(/^onebot:group:(\d+)$/i);
                    const effectiveIsGroup = groupMatch != null || Boolean(ig);
                    const effectiveGroupId = (groupMatch ? parseInt(groupMatch[1], 10) : undefined) ?? gid;

                    const usePlain = getRenderMarkdownToPlain(cfg);
                    let textPlain = usePlain ? markdownToPlain(trimmed) : trimmed;
                    if (getCollapseDoubleNewlines(cfg)) textPlain = collapseDoubleNewlines(textPlain);

                    // 解析模型输出的引用标记 [[quote:消息ID]]：从正文移除，记录引用目标
                    if (getQuoteEnabled(cfg)) {
                        const quoteMatch = textPlain.match(/^\s*\[\[\s*quote\s*:\s*([^\]]+?)\s*\]\]\s*/i);
                        if (quoteMatch) {
                            const num = quoteMatch[1].match(/-?\d+/);
                            textPlain = textPlain.slice(quoteMatch[0].length);
                            if (num) {
                                pendingQuoteId = num[0];
                                traceLog.info(`quote target detected: ${pendingQuoteId}`);
                            } else {
                                traceLog.warn(`quote target ignored (no numeric id): ${quoteMatch[1]}`);
                            }
                            if (!textPlain.trim() && !mediaUrl) return;
                        }
                    }

                    // @ 处理：[[at:QQ号]] / [CQ:at,qq=QQ号] 统一成合法 CQ 码，空号剥除；
                    // atEnabled=false 时移除所有 at（只发文本），避免字面 CQ 码漏到群里。
                    const atAllowed = isGroup && getAtEnabled(cfg);
                    const atParsed = normalizeAtMarkers(textPlain);
                    textPlain = atAllowed ? atParsed.text : atParsed.text.replace(/\[CQ:at,qq=\d+\]/g, "").trim();
                    if (atParsed.atUserIds.length > 0) {
                        traceLog.info(`at targets detected: ${atParsed.atUserIds.join(",")} allowed=${atAllowed}`);
                    }
                    if (!textPlain.trim() && !mediaUrl) return;

                    const shouldSendNow = longMessageMode === "normal";

                    if (!shouldSendNow) {
                        deliveredChunks.push({
                            index: chunkIndex++,
                            text: textPlain || undefined,
                            rawText: trimmed || undefined,
                            mediaUrl: mediaUrl || undefined,
                        });
                    }

                    // forward 模式且非最后一条：仅暂存，绝不发送，等 final 时再统一处理
                    if (longMessageMode === "forward" && info.kind !== "final") {
                        markForwardPending(replySessionId);
                        return;
                    }
                    if (info.kind === "final" && longMessageMode === "forward") {
                        clearForwardPending(replySessionId);
                    }

                    try {
                        if (shouldSendNow) {
                            if (mediaUrl) {
                                await queueNormalModeFlush(async () => {
                                    await flushBufferedNormalModeText(effectiveIsGroup, effectiveGroupId, uid);
                                    await doSendChunk(effectiveIsGroup, effectiveGroupId, uid, textPlain, mediaUrl);
                                    deliveredChunks.push({
                                        index: chunkIndex++,
                                        text: textPlain || undefined,
                                        rawText: trimmed || undefined,
                                        mediaUrl: mediaUrl || undefined,
                                    });
                                });
                            } else {
                                normalModeBufferedText = appendNormalModeText(normalModeBufferedText, textPlain);
                                normalModeBufferedRawText = appendNormalModeText(normalModeBufferedRawText, trimmed);

                                if (shouldFlushNormalModeBuffer()) {
                                    await queueNormalModeFlush(() => flushBufferedNormalModeText(effectiveIsGroup, effectiveGroupId, uid));
                                } else {
                                    scheduleNormalModeFlush(effectiveIsGroup, effectiveGroupId, uid);
                                }
                            }
                        }
                        if (info.kind === "final") {
                            if (shouldSendNow) {
                                await queueNormalModeFlush(() => flushBufferedNormalModeText(effectiveIsGroup, effectiveGroupId, uid));
                            }

                            const lastSentCount = lastSentChunkCountBySession.get(replySessionId) ?? 0;
                            const chunksToSend = deliveredChunks.slice(lastSentCount);
                            if (chunksToSend.length === 0) return;

                            const totalLen = deliveredChunks.reduce((s, c) => s + (c.rawText ?? c.text ?? "").length, 0);
                            const incrementalLen = chunksToSend.reduce((s, c) => s + (c.rawText ?? c.text ?? "").length, 0);
                            const isLong = totalLen > longMessageThreshold;
                            const isIncrementalLong = incrementalLen > longMessageThreshold;
                            const isIncremental = lastSentCount > 0;
                            traceLog.info(`final check: totalLen=${totalLen}, threshold=${longMessageThreshold}, isLong=${isLong}, isIncremental=${isIncremental}, deliveredChunks=${deliveredChunks.length}`);

                            if (isIncremental) {
                                setForwardSuppressDelivery(false);
                                // normal 模式下增量 chunk 已在 deliver 中实时发出；这里不能在 final 再补发一次。
                                if (!shouldSendNow && isIncrementalLong && (longMessageMode === "og_image" || longMessageMode === "forward")) {
                                    const fullRaw = chunksToSend.map((c) => c.rawText ?? c.text ?? "").join("\n\n");
                                    if (fullRaw.trim()) {
                                        if (longMessageMode === "og_image") {
                                            try {
                                                const imgUrl = await markdownToImage(fullRaw, { theme: getOgImageRenderTheme(api?.config) });
                                                if (imgUrl) {
                                                    if (effectiveIsGroup && effectiveGroupId) await sendGroupImage(effectiveGroupId, imgUrl, api.logger, getConfig);
                                                    else if (uid) await sendPrivateImage(uid, imgUrl, api.logger, getConfig);
                                                } else {
                                                    api.logger?.warn?.("[onebot] og_image (incremental): satori or sharp not installed, falling back to normal send");
                                                    for (const c of chunksToSend) {
                                                        if (c.text || c.mediaUrl) await doSendChunk(effectiveIsGroup, effectiveGroupId, uid, c.text ?? "", c.mediaUrl);
                                                    }
                                                }
                                            } catch (e: any) {
                                                api.logger?.error?.(`[onebot] og_image (incremental) failed: ${e?.message}`);
                                                for (const c of chunksToSend) {
                                                    if (c.text || c.mediaUrl) await doSendChunk(effectiveIsGroup, effectiveGroupId, uid, c.text ?? "", c.mediaUrl);
                                                }
                                            }
                                        } else {
                                            try {
                                                const nodes: Array<{ type: string; data: Record<string, unknown> }> = [];
                                                for (const c of chunksToSend) {
                                                    if (c.mediaUrl) {
                                                        const mid = await sendPrivateImage(selfId, c.mediaUrl, api.logger, getConfig);
                                                        if (mid) nodes.push({ type: "node", data: { id: String(mid) } });
                                                    } else if (c.text) {
                                                        const mid = await sendPrivateMsg(selfId, c.text, getConfig);
                                                        if (mid) nodes.push({ type: "node", data: { id: String(mid) } });
                                                    }
                                                }
                                                if (nodes.length > 0) {
                                                    if (effectiveIsGroup && effectiveGroupId) await sendGroupForwardMsg(effectiveGroupId, nodes, getConfig);
                                                    else if (uid) await sendPrivateForwardMsg(uid, nodes, getConfig);
                                                } else {
                                                    for (const c of chunksToSend) {
                                                        if (c.text || c.mediaUrl) await doSendChunk(effectiveIsGroup, effectiveGroupId, uid, c.text ?? "", c.mediaUrl);
                                                    }
                                                }
                                            } catch (e: any) {
                                                api.logger?.error?.(`[onebot] forward (incremental) failed: ${e?.message}`);
                                                for (const c of chunksToSend) {
                                                    if (c.text || c.mediaUrl) await doSendChunk(effectiveIsGroup, effectiveGroupId, uid, c.text ?? "", c.mediaUrl);
                                                }
                                            }
                                        }
                                    } else {
                                        for (const c of chunksToSend) {
                                            if (c.text || c.mediaUrl) await doSendChunk(effectiveIsGroup, effectiveGroupId, uid, c.text ?? "", c.mediaUrl);
                                        }
                                    }
                                } else if (!shouldSendNow) {
                                    for (const c of chunksToSend) {
                                        if (c.text || c.mediaUrl) await doSendChunk(effectiveIsGroup, effectiveGroupId, uid, c.text ?? "", c.mediaUrl);
                                    }
                                }
                            } else if (!shouldSendNow && (longMessageMode === "og_image" || longMessageMode === "forward")) {
                                traceLog.info(`checking og_image: isLong=${isLong}, mode=${longMessageMode}`);
                                if (isLong && longMessageMode === "og_image") {
                                    traceLog.info(`triggering og_image for ${totalLen} chars`);
                                    const fullRaw = deliveredChunks.map((c) => c.rawText ?? c.text ?? "").join("\n\n");
                                    if (fullRaw.trim()) {
                                        try {
                                            const imgUrl = await markdownToImage(fullRaw, { theme: getOgImageRenderTheme(api?.config) });
                                            if (imgUrl) {
                                                if (effectiveIsGroup && effectiveGroupId) await sendGroupImage(effectiveGroupId, imgUrl, api.logger, getConfig);
                                                else if (uid) await sendPrivateImage(uid, imgUrl, api.logger, getConfig);
                                            } else {
                                                api.logger?.warn?.("[onebot] og_image: satori or sharp not installed, falling back to normal send");
                                                setForwardSuppressDelivery(false);
                                                for (const c of deliveredChunks) {
                                                    if (c.text || c.mediaUrl) await doSendChunk(effectiveIsGroup, effectiveGroupId, uid, c.text ?? "", c.mediaUrl);
                                                }
                                            }
                                        } catch (e: any) {
                                            api.logger?.error?.(`[onebot] og_image failed: ${e?.message}`);
                                            setForwardSuppressDelivery(false);
                                            for (const c of deliveredChunks) {
                                                if (c.text || c.mediaUrl) await doSendChunk(effectiveIsGroup, effectiveGroupId, uid, c.text ?? "", c.mediaUrl);
                                            }
                                        }
                                    }
                                } else if (isLong && longMessageMode === "forward") {
                                    try {
                                        const nodes: Array<{ type: string; data: Record<string, unknown> }> = [];
                                        for (const c of deliveredChunks) {
                                            if (c.mediaUrl) {
                                                const mid = await sendPrivateImage(selfId, c.mediaUrl, api.logger, getConfig);
                                                if (mid) nodes.push({ type: "node", data: { id: String(mid) } });
                                            } else if (c.text) {
                                                const mid = await sendPrivateMsg(selfId, c.text, getConfig);
                                                if (mid) nodes.push({ type: "node", data: { id: String(mid) } });
                                            }
                                        }
                                        if (nodes.length > 0) {
                                            if (effectiveIsGroup && effectiveGroupId) await sendGroupForwardMsg(effectiveGroupId, nodes, getConfig);
                                            else if (uid) await sendPrivateForwardMsg(uid, nodes, getConfig);
                                        }
                                    } catch (e: any) {
                                        api.logger?.error?.(`[onebot] forward failed: ${e?.message}`);
                                        setForwardSuppressDelivery(false);
                                        for (const c of deliveredChunks) {
                                            if (c.text || c.mediaUrl) await doSendChunk(effectiveIsGroup, effectiveGroupId, uid, c.text ?? "", c.mediaUrl);
                                        }
                                    }
                                } else {
                                    setForwardSuppressDelivery(false);
                                    for (const c of deliveredChunks) {
                                        if (c.text || c.mediaUrl) await doSendChunk(effectiveIsGroup, effectiveGroupId, uid, c.text ?? "", c.mediaUrl);
                                    }
                                }
                            }

                            lastSentChunkCountBySession.set(replySessionId, deliveredChunks.length);

                            if (clearHistoryEntriesIfEnabled) {
                                clearHistoryEntriesIfEnabled({
                                    historyMap: sessionHistories,
                                    historyKey: sessionId,
                                    limit: historyLimit,
                                });
                            }
                            if (onReplySessionEnd) {
                                const ctx: ReplySessionContext = {
                                    replySessionId,
                                    sessionId,
                                    to: replyTarget,
                                    chunks: deliveredChunks.map(({ index, text: t, mediaUrl: m }) => ({ index, text: t, mediaUrl: m })),
                                    userMessage: messageText,
                                };
                                if (typeof onReplySessionEnd === "function") {
                                    await onReplySessionEnd(ctx);
                                } else if (typeof onReplySessionEnd === "string" && onReplySessionEnd.trim()) {
                                    const { loadScript } = await import("../load-script.js");
                                    const mod = await loadScript(onReplySessionEnd.trim());
                                    const fn = mod?.default ?? mod?.onReplySessionEnd;
                                    if (typeof fn === "function") await fn(ctx);
                                }
                            }
                        }
                    } catch (e: any) {
                        traceLog.error(`deliver failed: ${e?.message}`);
                    }
                },
                onError: async (err: any, info: any) => {
                    traceLog.error(`${info?.kind} reply failed: ${err}`);
                    await clearEmojiReaction();
                },
            },
            replyOptions: { disableBlockStreaming: longMessageMode !== "normal" },
        });
        traceLog.info(`dispatchReplyWithBufferedBlockDispatcher returned successfully.`);
    } catch (err: any) {
        await clearEmojiReaction();
        // 异常时清空缓冲，避免 finally 补发半截正文后再发错误消息
        traceLog.error(`dispatch catch block: err=${err?.message}, receivedFinal=${receivedFinal}, chunkIndex=${chunkIndex}`);
        normalModeBufferedText = "";
        normalModeBufferedRawText = "";
        try {
            const { userId: uid, groupId: gid, isGroup: ig } = (ctxPayload as any)._onebot || {};
            if (ig && gid) await sendGroupMsg(gid, `处理失败: ${err?.message?.slice(0, 80) || "未知错误"}`);
            else if (uid) await sendPrivateMsg(uid, `处理失败: ${err?.message?.slice(0, 80) || "未知错误"}`);
        } catch (_) { }
    } finally {
        traceLog.info(`dispatch finally block: receivedFinal=${receivedFinal}, hasBuffered=${hasBufferedNormalModeText()}, bufferLen=${normalModeBufferedText.length}, hasTimer=${!!normalModeFlushTimer}, chunks=${deliveredChunks.length}`);
        // 补发缓冲池中残留的文本（引擎未发送 final 帧时会走到这里）
        if (hasBufferedNormalModeText()) {
            try {
                const { userId: uid, groupId: gid, isGroup: ig } = (ctxPayload as any)._onebot || {};
                const sessionKey = String((ctxPayload as any).SessionKey ?? sessionId);
                const groupMatch = sessionKey.match(/^onebot:group:(\d+)$/i);
                const effectiveIsGroup = groupMatch != null || Boolean(ig);
                const effectiveGroupId = (groupMatch ? parseInt(groupMatch[1], 10) : undefined) ?? gid;
                queueNormalModeFlush(() => flushBufferedNormalModeText(effectiveIsGroup, effectiveGroupId, uid));
                await normalModeFlushChain;
            } catch (e: any) {
                traceLog.error(`finally flush failed: ${e?.message ?? e}`);
            }
        }
        clearNormalModeFlushTimer("finally");
        setForwardSuppressDelivery(false);
        setActiveReplySelfId(null);
        lastSentChunkCountBySession.delete(replySessionId);
        clearForwardPending(replySessionId);
        setActiveReplySessionId(null);
        clearActiveReplyTarget();
    }
}

/** 回复会话上下文，供 onReplySessionEnd 钩子使用 */
export interface ReplySessionContext {
    /** 本次回复会话的唯一 ID，同一用户问题下的多次 deliver 共享此 ID */
    replySessionId: string;
    /** 会话标识，如 onebot:group:123 或 onebot:456 */
    sessionId: string;
    /** 回复目标，如 onebot:group:123 或 onebot:456 */
    to: string;
    /** 本次回复中已发送的所有块（按顺序） */
    chunks: Array<{ index: number; text?: string; mediaUrl?: string }>;
    /** 用户原始消息 */
    userMessage: string;
}
