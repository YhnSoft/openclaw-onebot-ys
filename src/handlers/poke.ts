/**
 * 戳一戳（poke / 拍一拍）事件处理
 *
 * 被戳的是机器人自己时，构造一条内部消息走完整的 processInboundMessage 回复管线：
 * 模型带人设、带群聊历史地自然回应（LLM 回应），而不是发固定文案。
 * 同群/同人冷却用于防连戳刷屏；可选 pokeBack 回戳。
 */

import type { OneBotAccountConfig, OneBotMessage } from "../types.js";
import { getOneBotConfig, getPokeReplyConfig } from "../config.js";
import { sendGroupPoke, sendFriendPoke } from "../connection.js";
import { processInboundMessage } from "./process-inbound.js";

/** 冷却状态：key = group:<群号>:<用户> 或 private:<用户> */
const lastPokeAt = new Map<string, number>();

/** 供单测重置冷却状态。 */
export function resetPokeState(): void {
    lastPokeAt.clear();
}

/** 判断事件是否是「戳机器人自己」。兼容 go-cqhttp / NapCat / Lagrange 的两种事件形态。 */
export function isPokeToSelf(msg: OneBotMessage): boolean {
    if (!msg || msg.post_type !== "notice") return false;
    const selfId = Number(msg.self_id ?? 0);
    if (!Number.isFinite(selfId) || selfId <= 0) return false;

    const noticeType = String(msg.notice_type ?? "");
    const subType = String(msg.sub_type ?? "");
    const isPoke = (noticeType === "notify" && subType === "poke") || noticeType === "poke";
    if (!isPoke) return false;

    // NapCat/go-cqhttp: target_id 是被戳者；部分实现把 user_id 当被戳者，兜底兼容
    const target = Number((msg.target_id as number | undefined) ?? msg.user_id ?? 0);
    return target === selfId;
}

/** 可注入依赖，便于单测不触碰真实 WS。 */
export interface PokeDeps {
    processInboundMessage: (api: any, msg: OneBotMessage) => Promise<void>;
    sendGroupPoke: (groupId: number, userId: number, getConfig?: () => OneBotAccountConfig | null) => Promise<void>;
    sendFriendPoke: (userId: number, getConfig?: () => OneBotAccountConfig | null) => Promise<void>;
}

const defaultDeps: PokeDeps = {
    processInboundMessage,
    sendGroupPoke,
    sendFriendPoke,
};

/** 处理一次戳一戳事件（由 service.ts 的 WS message 分发调用）。 */
export async function handlePoke(api: any, msg: OneBotMessage, deps: PokeDeps = defaultDeps): Promise<void> {
    const cfg = api?.config;
    const config = getOneBotConfig(api);
    if (!config) return;

    const poke = getPokeReplyConfig(cfg);
    if (!poke.enabled) return;
    if (!isPokeToSelf(msg)) return;

    const selfId = Number(msg.self_id ?? 0);
    const userId = Number(msg.user_id ?? 0);
    if (!userId) return;

    const isGroup = msg.group_id != null;
    const groupId = isGroup ? Number(msg.group_id) : 0;
    const key = isGroup ? `group:${groupId}:${userId}` : `private:${userId}`;

    // 冷却：防止连戳刷屏
    const now = Date.now();
    const last = lastPokeAt.get(key);
    if (last !== undefined && now - last < poke.cooldownMs) {
        const remain = Math.max(0, Math.ceil((poke.cooldownMs - (now - last)) / 1000));
        api.logger?.info?.(`[onebot][poke] group=${groupId || "-"} user=${userId} skip reason=cooldown remain=${remain}s`);
        return;
    }
    lastPokeAt.set(key, now);

    // 可选：回戳（失败不影响 LLM 回应）
    if (poke.pokeBack) {
        try {
            const getConfig = () => getOneBotConfig(api);
            if (isGroup && groupId > 0) await deps.sendGroupPoke(groupId, userId, getConfig);
            else await deps.sendFriendPoke(userId, getConfig);
        } catch (e: any) {
            api.logger?.warn?.(`[onebot][poke] poke back failed: ${e?.message ?? e}`);
        }
    }

    api.logger?.info?.(`[onebot][poke] group=${groupId || "-"} user=${userId} decision=reply source=llm`);

    // 构造内部消息：不设 message_id（避免对不存在消息做 emoji 反应），
    // 用 __onebotForceDispatch 跳过智能触发的 @/关键词/LLM 判定，直接进入回复管线。
    const synthetic: OneBotMessage = {
        post_type: "message",
        message_type: isGroup ? "group" : "private",
        group_id: isGroup ? groupId : undefined,
        user_id: userId,
        self_id: selfId,
        message: [{ type: "text", data: { text: poke.prompt } }],
        raw_message: poke.prompt,
        time: Math.floor(now / 1000),
        sender: msg.sender as OneBotMessage["sender"],
        __onebotForceDispatch: true,
    };

    await deps.processInboundMessage(api, synthetic);
}
