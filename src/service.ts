/**
 * OneBot WebSocket 服务
 *
 * 同时作为注册服务（api.registerService）和频道账号生命周期（gateway.startAccount）的连接入口，
 * 两个入口共用同一个连接 Promise，避免重复建立 WebSocket。
 */

import type { OneBotMessage } from "./types.js";
import type { WebSocket } from "ws";
import { getOneBotConfig } from "./config.js";
import { connectForward, createServerAndWait, setWs, stopConnection, handleEchoResponse, startImageTempCleanup, stopImageTempCleanup } from "./connection.js";
import { processInboundMessage } from "./handlers/process-inbound.js";
import { handleGroupIncrease } from "./handlers/group-increase.js";
import { handlePoke } from "./handlers/poke.js";
import { startScheduler, stopScheduler } from "./scheduler.js";

let serviceStartPromise: Promise<void> | null = null;

/** 给 OneBot WebSocket 挂上入站消息处理器（同一连接只挂一次）。 */
export function attachOneBotSocketHandlers(api: any, socket: WebSocket): void {
    const tagged = socket as WebSocket & { __onebotHandlersAttached?: boolean };
    if (tagged.__onebotHandlersAttached) return;
    tagged.__onebotHandlersAttached = true;

    socket.on("message", (data: Buffer) => {
        try {
            const payload = JSON.parse(data.toString());
            if (handleEchoResponse(payload)) return;
            if (payload.meta_event_type === "heartbeat") return;

            const msg = payload as OneBotMessage;
            if (msg.post_type === "message" && (msg.message_type === "private" || msg.message_type === "group")) {
                processInboundMessage(api, msg).catch((e) => {
                    api.logger?.error?.(`[onebot] processInboundMessage: ${e?.message}`);
                });
            } else if (msg.post_type === "notice" && msg.notice_type === "group_increase") {
                handleGroupIncrease(api, msg).catch((e) => {
                    api.logger?.error?.(`[onebot] handleGroupIncrease: ${e?.message}`);
                });
            } else if (
                msg.post_type === "notice" &&
                ((msg.notice_type === "notify" && msg.sub_type === "poke") || msg.notice_type === "poke")
            ) {
                // 戳一戳（拍一拍）：被戳的是机器人时走 LLM 回应，handlePoke 内部判断 target 与冷却
                handlePoke(api, msg).catch((e) => {
                    api.logger?.error?.(`[onebot] handlePoke: ${e?.message}`);
                });
            }
        } catch (e: any) {
            api.logger?.error?.(`[onebot] parse message: ${e?.message}`);
        }
    });

    socket.on("close", () => {
        api.logger?.info?.("[onebot] WebSocket closed");
    });

    socket.on("error", (e: Error) => {
        api.logger?.error?.(`[onebot] WebSocket error: ${e?.message}`);
    });
}

/** 建立 OneBot 连接（幂等）。服务启动和频道 startAccount 都调用这里。 */
export function startOneBotService(api: any): Promise<void> {
    if (serviceStartPromise) return serviceStartPromise;

    serviceStartPromise = (async () => {
        const config = getOneBotConfig(api);
        if (!config) {
            api.logger?.warn?.("[onebot] no config, service will not connect");
            return;
        }

        let socket: WebSocket;
        if (config.type === "forward-websocket") {
            socket = await connectForward(config);
        } else {
            socket = await createServerAndWait(config);
        }

        setWs(socket);
        api.logger?.info?.("[onebot] WebSocket connected");

        startImageTempCleanup();
        startScheduler(api);
        attachOneBotSocketHandlers(api, socket);
    })().catch((error) => {
        // 允许下一次调用重试
        serviceStartPromise = null;
        throw error;
    });

    return serviceStartPromise;
}

/** 停止连接并重置状态（服务 stop 与频道 stopAccount 共用）。 */
export function stopOneBotService(api?: any): void {
    serviceStartPromise = null;
    stopImageTempCleanup();
    stopScheduler();
    stopConnection();
    api?.logger?.info?.("[onebot] service stopped");
}

/** 仅重置连接 Promise，供连接断开后由频道生命周期触发重连。 */
export function resetOneBotService(): void {
    serviceStartPromise = null;
}

export function registerService(api: any): void {
    api.registerService({
        id: "onebot-ws",
        start: async () => {
            try {
                await startOneBotService(api);
            } catch (e: any) {
                api.logger?.error?.(`[onebot] start failed: ${e?.message}`);
            }
        },
        stop: async () => {
            stopOneBotService(api);
        },
    });
}
