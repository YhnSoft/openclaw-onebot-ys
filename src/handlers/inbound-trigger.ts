/**
 * 群聊触发决策
 *
 * 从 process-inbound 里抽出的「要不要回这条群消息」判断链，顺序固定：
 *   @ 必回 → 引用机器人直通 → smartTrigger（权限预检 → 关键词/别名直通 → 成本护栏 → LLM 判定）
 *   → requireMention 传统模式 → triggerKeywords 关键词模式
 *
 * 只负责决策，不负责发送；被 skip 时由调用方传入的 rememberMessage 记历史。
 * 所有 [onebot][smart] 日志与判定输入保持与原实现一致。
 */

import type { OneBotMessage } from "../types.js";
import type { SmartTriggerConfig } from "../config.js";
import type { JudgeIntent } from "../smart-trigger.js";
import { getTextFromSegments, getAtTargets } from "../message.js";
import {
    getWhitelistUserIds,
    getBlacklistUserIds,
    getTriggerKeywords,
    getTriggerMode,
} from "../config.js";
import {
    matchDirectTrigger,
    beginSmartTriggerJudge,
    endSmartTriggerJudge,
    noteSmartTriggerReply,
    judgeGroupMessage,
    shouldSkipDirectTrigger,
    noteDirectTrigger,
} from "../smart-trigger.js";
import { getGroupMemberInfo } from "../connection.js";

/** 触发判定结果：dispatch=false 表示已记历史并应直接 return */
export interface GroupTriggerDecision {
    dispatch: boolean;
    /** 放行后的接话方式（sass 时在 prompt 里注入吐槽风格提示） */
    smartReplyIntent?: JudgeIntent;
}

export interface GroupTriggerContext {
    api: any;
    cfg: any;
    msg: OneBotMessage;
    groupId: number;
    userId: number;
    selfId: number;
    /** 当前消息正文（已含引用链） */
    messageText: string;
    /** 引用消息纯文本（没有引用时为空串） */
    quotedText: string;
    /** 发送者展示名（昵称(qq: 数字)） */
    senderLabel: string;
    /** 调用方已算好的 @ 机器人标记 */
    isAtMentioned: boolean;
    /** 调用方已算好的「直接引用了机器人发言」标记 */
    isQuoteToBot: boolean;
    smart: SmartTriggerConfig;
    /** 取当前消息之前的群历史（用于 LLM 判定） */
    recentMessages: (limit: number) => Array<{ sender: string; body: string }>;
    /** 不回复时把当前消息记入群历史 */
    rememberMessage: () => void;
}

/**
 * 检查消息是否匹配触发关键词
 * @param text 消息文本
 * @param keywords 关键词列表
 * @param mode 匹配模式：prefix-前缀匹配，contains-包含匹配
 */
export function checkTriggerKeyword(text: string, keywords: string[], mode: "prefix" | "contains"): boolean {
    if (!text || keywords.length === 0) return false;

    for (const keyword of keywords) {
        if (!keyword) continue;

        if (mode === "prefix") {
            // 前缀匹配：消息以关键词开头（忽略前导空格）
            const trimmedText = text.trimStart();
            if (trimmedText.toLowerCase().startsWith(keyword.toLowerCase())) {
                return true;
            }
        } else {
            // 包含匹配：消息中包含关键词即可
            if (text.toLowerCase().includes(keyword.toLowerCase())) {
                return true;
            }
        }
    }
    return false;
}

/**
 * 判断一条群消息是否要进入回复流程。
 *
 * 注意：引用机器人的 `decision=reply source=quote-to-bot` 日志由调用方在白/黑名单
 * 检查之后再打，避免「先 decision=reply、后 denied」的误导顺序。
 */
export async function decideGroupTrigger(ctx: GroupTriggerContext): Promise<GroupTriggerDecision> {
    const {
        api,
        cfg,
        msg,
        groupId,
        userId,
        selfId,
        messageText,
        quotedText,
        senderLabel,
        isAtMentioned,
        isQuoteToBot,
        smart,
        rememberMessage,
    } = ctx;

    // @ 必回
    if (isAtMentioned) return { dispatch: true };

    // 引用机器人的发言 = 在跟它说话，等同 @：立即回复，跳过关键词/LLM 判定
    if (isQuoteToBot) return { dispatch: true, smartReplyIntent: "answer" };

    if (smart.enabled && (smart.groups.length === 0 || smart.groups.includes(Number(groupId)))) {
        // 白名单/黑名单：不允许的用户不进入智能触发，避免白白消耗 LLM 判定与冷却配额
        const smartWhitelist = getWhitelistUserIds(cfg);
        const smartBlacklist = getBlacklistUserIds(cfg);
        const smartDenied =
            (smartWhitelist.length > 0 && !smartWhitelist.includes(Number(userId))) ||
            (smartBlacklist.length > 0 && smartBlacklist.includes(Number(userId)));
        if (smartDenied) {
            api.logger?.info?.(`[onebot][smart] group=${groupId} decision=skip reason=permission`);
            rememberMessage();
            return { dispatch: false };
        }

        // 智能触发第一段：零成本直通（关键词 / 机器人别名）
        const textForTrigger = getTextFromSegments(msg).trim() || messageText.trim();
        const direct = matchDirectTrigger(textForTrigger, smart);

        if (direct) {
            // 直通去重：同一群里 minIntervalMs 内连发触发词只回一次，避免刷屏
            if (shouldSkipDirectTrigger(smart, Number(groupId))) {
                api.logger?.info?.(`[onebot][smart] group=${groupId} decision=skip reason=direct-repeat keyword="${direct}"`);
                rememberMessage();
                return { dispatch: false };
            }
            noteDirectTrigger(Number(groupId));
            api.logger?.info?.(`[onebot][smart] group=${groupId} decision=reply source=keyword keyword="${direct}"`);
            return { dispatch: true, smartReplyIntent: "answer" };
        }

        if (textForTrigger.length < smart.minMessageChars) {
            // 过短消息（纯表情/符号）不判定，只记历史
            api.logger?.info?.(`[onebot][smart] group=${groupId} decision=skip reason=too-short chars=${textForTrigger.length}`);
            rememberMessage();
            return { dispatch: false };
        }

        // 成本护栏 + 同群并发判定保护：拿到判定权才调用 LLM
        const guard = beginSmartTriggerJudge(smart, Number(groupId));
        if (!guard.allowed) {
            api.logger?.info?.(`[onebot][smart] group=${groupId} decision=skip reason=${guard.reason}`);
            rememberMessage();
            return { dispatch: false };
        }

        try {
            // 只取当前消息之前的历史（当前消息在判定通过后才 rememberMessage，避免重复）
            const recent = ctx.recentMessages(smart.historyLimit);
            // @ 目标带昵称：群里可能有人昵称也带「大肥鱼」这类词，
            // 只有 QQ 号等于 selfId 才是机器人自己，昵称只作为辅助信息。
            const judgeAtTargets = await Promise.all(
                getAtTargets(msg).map(async (atQq) => {
                    if (Number(atQq) === Number(selfId)) return { qq: atQq };
                    try {
                        const info = await getGroupMemberInfo(Number(groupId), Number(atQq));
                        const name = info?.card || info?.nickname || "";
                        return name ? { qq: atQq, name } : { qq: atQq };
                    } catch {
                        return { qq: atQq };
                    }
                }),
            );
            // 智能触发第二段：让宿主 LLM 判断是否值得接话
            const verdict = await judgeGroupMessage({
                api,
                smart,
                groupId: Number(groupId),
                selfId,
                senderLabel,
                messageText,
                recentMessages: recent,
                quotedText,
                // 让判定器知道这条消息 @ 了谁：@别人 ≠ 在叫机器人
                atTargets: judgeAtTargets,
            });

            if (!verdict.reply) {
                api.logger?.info?.(`[onebot][smart] group=${groupId} decision=ignore source=${verdict.source} confidence=${verdict.confidence ?? "-"} reason="${verdict.reason ?? verdict.error ?? ""}" latencyMs=${verdict.latencyMs}`);
                rememberMessage();
                return { dispatch: false };
            }

            // 放行：记为一次回复，后续继续原有 dispatch 流程
            const smartReplyIntent = verdict.intent ?? "answer";
            noteSmartTriggerReply(Number(groupId));
            api.logger?.info?.(`[onebot][smart] group=${groupId} decision=reply source=${verdict.source} confidence=${verdict.confidence ?? "-"} intent=${smartReplyIntent} reason="${verdict.reason ?? ""}" latencyMs=${verdict.latencyMs} model=${verdict.model ?? "-"}`);
            return { dispatch: true, smartReplyIntent };
        } finally {
            // 无论放行、忽略还是异常，都释放同群判定权
            endSmartTriggerJudge(Number(groupId));
        }
    }

    const requireMention = (cfg?.channels?.onebot as any)?.requireMention ?? true;
    if (requireMention) {
        // 传统模式：必须 @ 才响应
        api.logger?.info?.(`[onebot] ignoring group message without @mention`);
        rememberMessage();
        return { dispatch: false };
    }

    // 关键词模式：配置 triggerKeywords 时，需匹配关键词才响应
    const triggerKeywords = getTriggerKeywords(cfg);
    if (triggerKeywords.length > 0) {
        const triggerMode = getTriggerMode(cfg);
        const textFromMsg = getTextFromSegments(msg).trim() || messageText.trim();
        const matched = checkTriggerKeyword(textFromMsg, triggerKeywords, triggerMode);

        if (!matched) {
            api.logger?.info?.(`[onebot] ignoring group message, no trigger keyword matched`);
            rememberMessage();
            return { dispatch: false };
        }
        api.logger?.info?.(`[onebot] trigger keyword matched, processing message`);
    }
    // 如果没有配置关键词，则所有消息都响应（降级到原逻辑）
    return { dispatch: true };
}
