/**
 * OneBot WebSocket 连接与 API 调用
 *
 * 图片消息：
 * - 本机回环连接时：网络 URL 会先下载到本地再发送（兼容部分实现的 retcode 1200）
 * - 跨机器连接时：本地文件会自动转成 base64://，避免把宿主机绝对路径发给远端 OneBot
 * 并定期清理临时文件。
 */

import Fuse from "fuse.js";
import WebSocket from "ws";
import { createServer } from "http";
import https from "https";
import http from "http";
import { readdirSync, readFileSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { OneBotAccountConfig } from "./types.js";
import { logSend } from "./send-debug-log.js";
import { shouldBlockSendInForwardMode, getActiveReplyTarget, getActiveReplySessionId } from "./reply-context.js";
import { noteSentMessage } from "./recall.js";

const IMAGE_TEMP_DIR = join(tmpdir(), "openclaw-onebot");
const DOWNLOAD_TIMEOUT_MS = 30000;

/** 使用 Node 内置 http(s) 下载 URL，避免 fetch 在某些环境下的兼容性问题 */
function downloadUrl(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith("https") ? https : http;
        const req = lib.get(url, (res) => {
            const redirect = res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location;
            if (redirect) {
                downloadUrl(redirect.startsWith("http") ? redirect : new URL(redirect, url).href).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode && res.statusCode >= 400) {
                reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage}`));
                return;
            }
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
        });
        req.on("error", reject);
        req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
            req.destroy();
            reject(new Error("Download timeout"));
        });
    });
}
const IMAGE_TEMP_MAX_AGE_MS = 60 * 60 * 1000; // 1 小时
const IMAGE_TEMP_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 每小时清理一次

let imageTempCleanupTimer: ReturnType<typeof setInterval> | null = null;

/** 清理过期的临时图片文件 */
function cleanupImageTemp(): void {
    try {
        if (!readdirSync) return;
        const files = readdirSync(IMAGE_TEMP_DIR);
        const now = Date.now();
        for (const f of files) {
            const p = join(IMAGE_TEMP_DIR, f);
            try {
                const st = statSync(p);
                if (st.isFile() && now - st.mtimeMs > IMAGE_TEMP_MAX_AGE_MS) {
                    unlinkSync(p);
                }
            } catch {
                /* ignore */
            }
        }
    } catch {
        /* dir not exist or readdir failed */
    }
}

async function resolveImageToBuffer(image: string): Promise<Buffer> {
    const trimmed = image?.trim();
    if (!trimmed) throw new Error("Empty image");

    if (/^https?:\/\//i.test(trimmed)) {
        return downloadUrl(trimmed);
    }
    if (trimmed.startsWith("base64://")) {
        return Buffer.from(trimmed.slice(9), "base64");
    }
    if (trimmed.startsWith("file://")) {
        return readFileSync(trimmed.slice(7));
    }
    return readFileSync(trimmed);
}

async function resolveImageFileForSend(image: string): Promise<string> {
    const trimmed = image?.trim() ?? "";
    // OneBot 实现（NapCat / Lagrange）可能运行在 Docker 容器或远端主机上，
    // 看不到 OpenClaw 宿主机上的临时文件路径（曾导致 send_group_msg retcode=100）。
    // 因此本地路径 / file:// / http(s) URL 统一转 base64:// 发送，只有 base64 原样透传。
    if (trimmed.startsWith("base64://")) return trimmed;
    return `base64://${(await resolveImageToBuffer(trimmed)).toString("base64")}`;
}

/** 启动临时图片定期清理（每小时执行一次） */
export function startImageTempCleanup(): void {
    stopImageTempCleanup();
    imageTempCleanupTimer = setInterval(cleanupImageTemp, IMAGE_TEMP_CLEANUP_INTERVAL_MS);
    // 后台清理不应阻止进程退出：CLI 子命令（如 openclaw onebot setup）加载插件后
    // 若没有 unref，事件循环永远不会清空，命令会卡在最后一行不返回。
    imageTempCleanupTimer.unref?.();
}

/** 停止临时图片定期清理 */
export function stopImageTempCleanup(): void {
    if (imageTempCleanupTimer) {
        clearInterval(imageTempCleanupTimer);
        imageTempCleanupTimer = null;
    }
}


let ws: WebSocket | null = null;
let wsServer: import("ws").WebSocketServer | null = null;
let httpServer: import("http").Server | null = null;
const pendingEcho = new Map<string, { resolve: (v: any) => void }>();
let echoCounter = 0;

let connectionReadyResolve: (() => void) | null = null;
const connectionReadyPromise = new Promise<void>((r) => { connectionReadyResolve = r; });

function nextEcho(): string {
    return `onebot-${Date.now()}-${++echoCounter}`;
}

export function handleEchoResponse(payload: any): boolean {
    if (payload?.echo && pendingEcho.has(payload.echo)) {
        const h = pendingEcho.get(payload.echo);
        h?.resolve(payload);
        return true;
    }
    return false;
}

function getLogger(): { info?: (s: string) => void; warn?: (s: string) => void } {
    return (globalThis as any).__onebotApi?.logger ?? {};
}

/**
 * 从 OneBot 响应中提取消息 ID。
 * 不同实现的返回字段不完全一致（message_id / messageId / id，或在顶层），
 * 全部缺失时返回 undefined，由上层决定是否生成兜底回执 ID。
 */
function extractMessageId(res: any): string | number | undefined {
    const candidates = [
        res?.data?.message_id,
        res?.data?.messageId,
        res?.data?.id,
        res?.message_id,
        res?.messageId,
    ];
    for (const candidate of candidates) {
        if (candidate === null || candidate === undefined) continue;
        const value = String(candidate).trim();
        if (value && value !== "undefined" && value !== "null") return candidate as string | number;
    }
    return undefined;
}

function sendOneBotAction(wsocket: WebSocket, action: string, params: Record<string, unknown>, log = getLogger()): Promise<any> {
    const echo = nextEcho();
    const payload = { action, params, echo };

    // Log the initiation of the action with basic target info
    const targetInfo = params.group_id ? `group=${params.group_id}` : (params.user_id ? `user=${params.user_id}` : "");
    log.info?.(`[onebot-trace] sendOneBotAction action=${action} echo=${echo} ${targetInfo}`);

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pendingEcho.delete(echo);
            log.warn?.(`[onebot-trace] sendOneBotAction ${action} timeout for echo=${echo}, ws.readyState=${wsocket.readyState}`);
            reject(new Error(`OneBot action ${action} timeout (echo=${echo}, ws.readyState=${wsocket.readyState})`));
        }, 15000);

        pendingEcho.set(echo, {
            resolve: (v) => {
                clearTimeout(timeout);
                pendingEcho.delete(echo);
                log.info?.(`[onebot-trace] echo ${echo} resolved with retcode=${v?.retcode} message_id=${v?.data?.message_id ?? "unknown"}`);
                if (v?.retcode !== 0) log.warn?.(`[onebot-trace] sendOneBotAction ${action} retcode=${v?.retcode} msg=${v?.msg ?? ""}`);
                resolve(v);
            },
        });

        wsocket.send(JSON.stringify(payload), (err: Error | undefined) => {
            if (err) {
                pendingEcho.delete(echo);
                clearTimeout(timeout);
                log.warn?.(`[onebot-trace] sendOneBotAction ${action} wsocket.send error for echo=${echo}: ${err.message}`);
                reject(err);
            }
        });
    });
}

export function getWs(): WebSocket | null {
    return ws;
}

/** 为 WebSocket 设置 echo 响应处理（按需连接时需调用，以便 sendOneBotAction 能收到响应） */
function setupEchoHandler(socket: WebSocket): void {
    socket.on("message", (data: Buffer) => {
        try {
            const payload = JSON.parse(data.toString());
            handleEchoResponse(payload);
        } catch {
            /* ignore */
        }
    });
}

/** 等待 WebSocket 连接就绪（service 启动后异步建立连接，发送前需先等待） */
export async function waitForConnection(timeoutMs = 30000): Promise<WebSocket> {
    if (ws && ws.readyState === WebSocket.OPEN) return ws;
    const log = getLogger();
    log.info?.("[onebot] waitForConnection: waiting for WebSocket...");
    return Promise.race([
        connectionReadyPromise.then(() => {
            if (ws && ws.readyState === WebSocket.OPEN) return ws;
            throw new Error("OneBot WebSocket not connected");
        }),
        new Promise<never>((_, reject) =>
            setTimeout(
                () => reject(new Error(`OneBot WebSocket not connected after ${timeoutMs}ms. Ensure "openclaw gateway run" is running and OneBot (Lagrange.Core) is connected.`)),
                timeoutMs
            )
        ),
    ]);
}

/**
 * 确保有可用的 WebSocket 连接。当 service 未启动时，
 * forward-websocket 模式直接建立连接（message send 可独立运行）；
 * backward-websocket 模式需等待 gateway 的 service 建立连接。
 */
export async function ensureConnection(
    getConfig: () => OneBotAccountConfig | null,
    timeoutMs = 30000
): Promise<WebSocket> {
    if (ws && ws.readyState === WebSocket.OPEN) return ws;
    const config = getConfig();
    if (!config) throw new Error("OneBot not configured");
    const log = getLogger();
    if (config.type === "forward-websocket") {
        log.info?.("[onebot] 连接 OneBot (forward-websocket)...");
        const socket = await connectForward(config);
        setupEchoHandler(socket);
        setWs(socket);
        return socket;
    }
    return waitForConnection(timeoutMs);
}

/**
 * 解析文本中的 CQ 码为 OneBot 消息段；没有 CQ 码时返回 null（调用方保持纯文本发送）。
 * 仅用于出站：把模型 / 插件拼出的 `[CQ:at,qq=...]` 转成真正的 at 段。
 */
export function textToSegments(text: string): Array<{ type: string; data: Record<string, unknown> }> | null {
    const re = /\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g;
    if (!re.test(text)) return null;
    re.lastIndex = 0;

    const decodeCq = (v: string): string =>
        v
            .replace(/&#44;/g, ",")
            .replace(/&#91;/g, "[")
            .replace(/&#93;/g, "]")
            .replace(/&amp;/g, "&");

    const segments: Array<{ type: string; data: Record<string, unknown> }> = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        if (match.index > lastIndex) {
            segments.push({ type: "text", data: { text: text.slice(lastIndex, match.index) } });
        }
        const type = match[1];
        const data: Record<string, unknown> = {};
        const rawParams = (match[2] ?? "").replace(/^,/, "");
        for (const kv of rawParams.split(",")) {
            if (!kv) continue;
            const idx = kv.indexOf("=");
            if (idx === -1) continue;
            data[kv.slice(0, idx)] = decodeCq(kv.slice(idx + 1));
        }
        segments.push({ type, data });
        lastIndex = re.lastIndex;
    }
    if (lastIndex < text.length) {
        segments.push({ type: "text", data: { text: text.slice(lastIndex) } });
    }
    return segments.length > 0 ? segments : null;
}

/**
 * 构造带引用（reply 段）与 @ 段（文本里的 CQ 码）的 OneBot 消息体。
 * 无引用且无 CQ 码时保持纯文本字符串，兼容不支持消息段数组的实现。
 */
function buildQuotedMessage(
    text: string,
    replyTo?: string | number
): string | Array<{ type: string; data: Record<string, unknown> }> {
    const segments = textToSegments(text);
    const hasReply = replyTo != null && String(replyTo).trim() !== "";

    if (!segments) {
        if (!hasReply) return text;
        return [
            { type: "reply", data: { id: String(replyTo) } },
            { type: "text", data: { text } },
        ];
    }

    if (!hasReply) return segments;
    return [{ type: "reply", data: { id: String(replyTo) } }, ...segments];
}

export async function sendPrivateMsg(
    userId: number,
    text: string,
    getConfig?: () => OneBotAccountConfig | null,
    replyTo?: string | number
): Promise<string | number | undefined> {
    if (shouldBlockSendInForwardMode("private", userId)) {
        logSend("connection", "sendPrivateMsg", { targetId: userId, blocked: true, sessionId: getActiveReplyTarget(), replySessionId: getActiveReplySessionId() });
        return undefined;
    }
    logSend("connection", "sendPrivateMsg", {
        targetType: "user",
        targetId: userId,
        textPreview: text?.slice(0, 80),
        textLen: text?.length,
        replyTo,
        sessionId: getActiveReplyTarget(),
        replySessionId: getActiveReplySessionId(),
    });
    const socket = getConfig
        ? await ensureConnection(getConfig)
        : await waitForConnection();
    const res = await sendOneBotAction(socket, "send_private_msg", { user_id: userId, message: buildQuotedMessage(text, replyTo) });
    if (res?.retcode !== 0) {
        throw new Error(res?.msg ?? `OneBot send_private_msg failed (retcode=${res?.retcode})`);
    }
    const mid = extractMessageId(res);
    noteSentMessage(`user:${userId}`, mid);
    logSend("connection", "sendPrivateMsg", { targetId: userId, messageId: mid, sessionId: getActiveReplyTarget(), replySessionId: getActiveReplySessionId() });
    return mid;
}

export async function sendGroupMsg(
    groupId: number,
    text: string,
    getConfig?: () => OneBotAccountConfig | null,
    replyTo?: string | number
): Promise<string | number | undefined> {
    if (shouldBlockSendInForwardMode("group", groupId)) {
        logSend("connection", "sendGroupMsg", { targetId: groupId, blocked: true, sessionId: getActiveReplyTarget(), replySessionId: getActiveReplySessionId() });
        return undefined;
    }
    logSend("connection", "sendGroupMsg", {
        targetType: "group",
        targetId: groupId,
        textPreview: text?.slice(0, 80),
        textLen: text?.length,
        replyTo,
        sessionId: getActiveReplyTarget(),
        replySessionId: getActiveReplySessionId(),
    });
    const socket = getConfig
        ? await ensureConnection(getConfig)
        : await waitForConnection();
    const res = await sendOneBotAction(socket, "send_group_msg", { group_id: groupId, message: buildQuotedMessage(text, replyTo) });
    if (res?.retcode !== 0) {
        throw new Error(res?.msg ?? `OneBot send_group_msg failed (retcode=${res?.retcode})`);
    }
    const mid = extractMessageId(res);
    noteSentMessage(`group:${groupId}`, mid);
    logSend("connection", "sendGroupMsg", { targetId: groupId, messageId: mid, sessionId: getActiveReplyTarget(), replySessionId: getActiveReplySessionId() });
    return mid;
}

export async function sendGroupImage(
    groupId: number,
    image: string,
    log: { info?: (s: string) => void; warn?: (s: string) => void } = getLogger(),
    getConfig?: () => OneBotAccountConfig | null
): Promise<string | number | undefined> {
    if (shouldBlockSendInForwardMode("group", groupId)) {
        logSend("connection", "sendGroupImage", { targetId: groupId, blocked: true, sessionId: getActiveReplyTarget(), replySessionId: getActiveReplySessionId() });
        return undefined;
    }
    logSend("connection", "sendGroupImage", {
        targetType: "group",
        targetId: groupId,
        imagePreview: image?.slice?.(0, 60),
        sessionId: getActiveReplyTarget(),
        replySessionId: getActiveReplySessionId(),
    });
    log.info?.(`[onebot] sendGroupImage entry: groupId=${groupId} image=${image?.slice?.(0, 80) ?? ""}`);
    const socket = getConfig ? await ensureConnection(getConfig) : await waitForConnection();

    try {
        const filePath = image.startsWith("[") ? null : await resolveImageFileForSend(image);
        const seg = image.startsWith("[")
            ? JSON.parse(image)
            : [{ type: "image", data: { file: filePath! } }];

        const res = await sendOneBotAction(socket, "send_group_msg", { group_id: groupId, message: seg }, log);
        if (res?.retcode !== 0) {
            throw new Error(res?.msg ?? `OneBot send_group_msg (image) failed (retcode=${res?.retcode})`);
        }
        log.info?.(`[onebot] sendGroupImage done: retcode=${res?.retcode ?? "?"}`);
        const mid = extractMessageId(res);
        noteSentMessage(`group:${groupId}`, mid);
        logSend("connection", "sendGroupImage", { targetId: groupId, messageId: mid, sessionId: getActiveReplyTarget(), replySessionId: getActiveReplySessionId() });
        return mid;
    } catch (error) {
        log.warn?.(`[onebot] sendGroupImage error: ${error}`);
    }
}

/** 发送群合并转发消息。messages 为节点数组，每节点 { type: "node", data: { id } } 或 { type: "node", data: { user_id, nickname, content } } */
export async function sendGroupForwardMsg(
    groupId: number,
    messages: Array<{ type: string; data: Record<string, unknown> }>,
    getConfig?: () => OneBotAccountConfig | null
): Promise<void> {
    logSend("connection", "sendGroupForwardMsg", {
        targetType: "group",
        targetId: groupId,
        nodeCount: messages.length,
        isForward: true,
        sessionId: getActiveReplyTarget(),
        replySessionId: getActiveReplySessionId(),
    });
    const socket = getConfig ? await ensureConnection(getConfig) : await waitForConnection();
    const res = await sendOneBotAction(socket, "send_group_forward_msg", { group_id: groupId, messages });
    if (res?.retcode !== 0) {
        throw new Error(res?.msg ?? `OneBot send_group_forward_msg failed (retcode=${res?.retcode})`);
    }
}

/** 发送私聊合并转发消息 */
export async function sendPrivateForwardMsg(
    userId: number,
    messages: Array<{ type: string; data: Record<string, unknown> }>,
    getConfig?: () => OneBotAccountConfig | null
): Promise<void> {
    logSend("connection", "sendPrivateForwardMsg", {
        targetType: "user",
        targetId: userId,
        nodeCount: messages.length,
        isForward: true,
        sessionId: getActiveReplyTarget(),
        replySessionId: getActiveReplySessionId(),
    });
    const socket = getConfig ? await ensureConnection(getConfig) : await waitForConnection();
    const res = await sendOneBotAction(socket, "send_private_forward_msg", { user_id: userId, messages });
    if (res?.retcode !== 0) {
        throw new Error(res?.msg ?? `OneBot send_private_forward_msg failed (retcode=${res?.retcode})`);
    }
}

export async function sendPrivateImage(
    userId: number,
    image: string,
    log: { info?: (s: string) => void; warn?: (s: string) => void } = getLogger(),
    getConfig?: () => OneBotAccountConfig | null
): Promise<string | number | undefined> {
    if (shouldBlockSendInForwardMode("private", userId)) {
        logSend("connection", "sendPrivateImage", { targetId: userId, blocked: true, sessionId: getActiveReplyTarget(), replySessionId: getActiveReplySessionId() });
        return undefined;
    }
    logSend("connection", "sendPrivateImage", {
        targetType: "user",
        targetId: userId,
        imagePreview: image?.slice?.(0, 60),
        sessionId: getActiveReplyTarget(),
        replySessionId: getActiveReplySessionId(),
    });
    log.info?.(`[onebot] sendPrivateImage entry: userId=${userId} image=${image?.slice?.(0, 80) ?? ""}`);
    const socket = getConfig ? await ensureConnection(getConfig) : await waitForConnection();
    const filePath = image.startsWith("[") ? null : await resolveImageFileForSend(image);
    const seg = image.startsWith("[")
        ? JSON.parse(image)
        : [{ type: "image", data: { file: filePath! } }];
    const res = await sendOneBotAction(socket, "send_private_msg", { user_id: userId, message: seg }, log);
    if (res?.retcode !== 0) {
        throw new Error(res?.msg ?? `OneBot send_private_msg (image) failed (retcode=${res?.retcode})`);
    }
    log.info?.(`[onebot] sendPrivateImage done: retcode=${res?.retcode ?? "?"}`);
    const mid = extractMessageId(res);
    noteSentMessage(`user:${userId}`, mid);
    logSend("connection", "sendPrivateImage", { targetId: userId, messageId: mid, sessionId: getActiveReplyTarget(), replySessionId: getActiveReplySessionId() });
    return mid;
}

export async function uploadGroupFile(
    groupId: number,
    file: string,
    name: string,
    getConfig?: () => OneBotAccountConfig | null
): Promise<void> {
    const socket = getConfig
        ? await ensureConnection(getConfig)
        : await waitForConnection();
    const res = await sendOneBotAction(socket, "upload_group_file", { group_id: groupId, file, name });
    if (res?.retcode !== 0) {
        throw new Error(res?.msg ?? `OneBot upload_group_file failed (retcode=${res?.retcode})`);
    }
}

export async function uploadPrivateFile(
    userId: number,
    file: string,
    name: string,
    getConfig?: () => OneBotAccountConfig | null
): Promise<void> {
    const socket = getConfig
        ? await ensureConnection(getConfig)
        : await waitForConnection();
    const res = await sendOneBotAction(socket, "upload_private_file", { user_id: userId, file, name });
    if (res?.retcode !== 0) {
        throw new Error(res?.msg ?? `OneBot upload_private_file failed (retcode=${res?.retcode})`);
    }
}

/** 撤回消息 */
export async function deleteMsg(messageId: number): Promise<void> {
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("OneBot WebSocket not connected");
    const res = await sendOneBotAction(ws, "delete_msg", { message_id: messageId });
    if (res?.retcode !== 0) {
        throw new Error(res?.msg ?? `OneBot delete_msg failed (retcode=${res?.retcode})`);
    }
}

/**
 * 对消息进行表情回应（Lagrange/QQ NT 扩展 API）
 * @param message_id 需要回应的消息 ID（用户发送的消息）
 * @param emoji_id 表情 ID，1 通常为点赞
 * @param is_set true 添加，false 取消
 */
export async function setMsgEmojiLike(message_id: number, emoji_id: number, is_set: boolean = true): Promise<void> {
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("OneBot WebSocket not connected");
    await sendOneBotAction(ws, "set_msg_emoji_like", { message_id, emoji_id, is_set });
}

/**
 * 戳一戳（群聊）：NapCat / Lagrange 扩展 API `group_poke`
 * @param groupId 群号
 * @param userId 被戳的人
 */
export async function sendGroupPoke(
    groupId: number,
    userId: number,
    getConfig?: () => OneBotAccountConfig | null
): Promise<void> {
    const socket = getConfig ? await ensureConnection(getConfig) : await waitForConnection();
    const res = await sendOneBotAction(socket, "group_poke", { group_id: groupId, user_id: userId });
    if (res?.retcode !== 0) {
        throw new Error(res?.msg ?? `OneBot group_poke failed (retcode=${res?.retcode})`);
    }
}

/**
 * 戳一戳（私聊）：NapCat / Lagrange 扩展 API `friend_poke`
 * @param userId 被戳的人
 */
export async function sendFriendPoke(
    userId: number,
    getConfig?: () => OneBotAccountConfig | null
): Promise<void> {
    const socket = getConfig ? await ensureConnection(getConfig) : await waitForConnection();
    const res = await sendOneBotAction(socket, "friend_poke", { user_id: userId });
    if (res?.retcode !== 0) {
        throw new Error(res?.msg ?? `OneBot friend_poke failed (retcode=${res?.retcode})`);
    }
}

/** 获取陌生人信息（含 nickname） */
export async function getStrangerInfo(userId: number): Promise<{ nickname: string } | null> {
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    try {
        const res = await sendOneBotAction(ws, "get_stranger_info", { user_id: userId, no_cache: false });
        if (res?.retcode === 0 && res?.data) return { nickname: String(res.data.nickname ?? "") };
        return null;
    } catch {
        return null;
    }
}

/** 获取群成员信息（含 nickname、card） */
export async function getGroupMemberInfo(groupId: number, userId: number): Promise<{ nickname: string; card: string } | null> {
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    try {
        const res = await sendOneBotAction(ws, "get_group_member_info", { group_id: groupId, user_id: userId, no_cache: false });
        if (res?.retcode === 0 && res?.data) {
            return { nickname: String(res.data.nickname ?? ""), card: String(res.data.card ?? "") };
        }
        return null;
    } catch {
        return null;
    }
}

/** 群成员简要信息（用于列表与搜索） */
export interface GroupMemberItem {
    user_id: number;
    nickname: string;
    card: string;
}

/**
 * 获取群成员列表（OneBot get_group_member_list）
 */
export async function getGroupMemberList(groupId: number): Promise<GroupMemberItem[]> {
    if (!ws || ws.readyState !== WebSocket.OPEN) return [];
    try {
        const res = await sendOneBotAction(ws, "get_group_member_list", { group_id: groupId });
        if (res?.retcode !== 0 || !Array.isArray(res?.data)) return [];
        return res.data.map((m: any) => ({
            user_id: Number(m.user_id),
            nickname: String(m.nickname ?? ""),
            card: String(m.card ?? ""),
        }));
    } catch {
        return [];
    }
}

/**
 * 按名字模糊匹配群成员（匹配群名片 card 与昵称 nickname），返回匹配到的 QQ 与展示名。
 * 使用 Fuse.js 模糊匹配，结果按相关度排序。
 */
export async function searchGroupMemberByName(
    groupId: number,
    name: string
): Promise<Array<{ user_id: number; nickname: string; card: string; displayName: string }>> {
    const list = await getGroupMemberList(groupId);
    const keyword = (name || "").trim();
    if (!keyword) return [];
    const fuse = new Fuse(list, {
        keys: ["card", "nickname"],
        includeScore: true,
        threshold: 0.4,
        ignoreLocation: true,
    });
    const results = fuse.search(keyword);
    return results.map(({ item: m }) => ({
        user_id: m.user_id,
        nickname: m.nickname,
        card: m.card,
        displayName: m.card || m.nickname || String(m.user_id),
    }));
}

/** 获取群信息（含 group_name） */
export async function getGroupInfo(groupId: number): Promise<{ group_name: string } | null> {
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    try {
        const res = await sendOneBotAction(ws, "get_group_info", { group_id: groupId, no_cache: false });
        if (res?.retcode === 0 && res?.data) return { group_name: String(res.data.group_name ?? "") };
        return null;
    } catch {
        return null;
    }
}

/** QQ 头像 URL，s=640 为常用尺寸 */
export function getAvatarUrl(userId: number, size: number = 640): string {
    return `https://q1.qlogo.cn/g?b=qq&nk=${userId}&s=${size}`;
}

/** 获取单条消息（需 OneBot 实现支持） */
export async function getMsg(messageId: number): Promise<{
    time: number;
    message_type: string;
    message_id: number;
    real_id: number;
    sender: { user_id?: number; nickname?: string };
    message: string | unknown[];
} | null> {
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    try {
        const res = await sendOneBotAction(ws, "get_msg", { message_id: messageId });
        if (res?.retcode === 0 && res?.data) return res.data;
        return null;
    } catch {
        return null;
    }
}

/**
 * 获取群聊历史消息（Lagrange.Core 扩展 API，与 Lagrange.onebot context 一致）
 * 仅使用 message_seq 分页（不传 message_id），与 Tiphareth getLast24HGroupMessages 调用方式一致。
 * @param groupId 群号
 * @param opts message_seq 起始序号（不传表示从最新一页）；count 本页条数；reverse_order true 表示从旧到新，便于用 batch[0].message_seq 向前翻页
 */
export async function getGroupMsgHistory(
    groupId: number,
    opts: { message_seq?: number; message_id?: number; count: number; reverse_order?: boolean } = { count: 20 }
): Promise<Array<{
    time: number;
    message_type: string;
    message_id: number;
    real_id?: number;
    message_seq?: number;
    sender: { user_id?: number; nickname?: string };
    message: string | unknown[];
}>> {
    if (!ws || ws.readyState !== WebSocket.OPEN) return [];
    try {
        const params: Record<string, unknown> = {
            group_id: groupId,
            count: opts.count ?? 20,
            reverse_order: opts.reverse_order !== false,
        };
        if (opts.message_seq != null && Number.isFinite(opts.message_seq)) {
            params.message_seq = opts.message_seq;
        }
        const res = await sendOneBotAction(ws, "get_group_msg_history", params);
        if (res?.retcode === 0 && res?.data?.messages) return res.data.messages;
        return [];
    } catch {
        return [];
    }
}

/** 单页请求之间的延迟（毫秒），与 Tiphareth historyMessages 一致 */
const HISTORY_PAGE_DELAY_MS = 500;

/**
 * 按时间范围分页获取群历史消息，严格对齐 Tiphareth getLast24HGroupMessages 算法：
 * getGroupMsgHistory(groupId, messageSeq, chunkSize, true)，用 batch[0] 的 message_seq 向前翻页，去重与时间截断。
 * @param groupId 群号
 * @param opts startTime 仅保留 >= startTime 的消息（Unix 秒）；limit 最多条数；chunkSize 每页条数
 */
export async function getGroupMsgHistoryInRange(
    groupId: number,
    opts: { startTime?: number; limit?: number; chunkSize?: number } = {}
): Promise<Array<{
    time: number;
    message_type: string;
    message_id: number;
    real_id?: number;
    message_seq?: number;
    sender: { user_id?: number; nickname?: string };
    message: string | unknown[];
}>> {
    const { startTime = 0, limit = 3000, chunkSize = 100 } = opts;
    let messageSeq: number | undefined = undefined;
    const allMessages: Array<{
        time: number;
        message_type: string;
        message_id: number;
        real_id?: number;
        message_seq?: number;
        sender: { user_id?: number; nickname?: string };
        message: string | unknown[];
    }> = [];
    const seenMessageIds = new Set<number>();
    let stopLoop = false;
    let pageCount = 0;

    while (!stopLoop) {
        pageCount++;

        const batch = await getGroupMsgHistory(groupId, {
            message_seq: messageSeq,
            count: chunkSize,
            reverse_order: true,
        });

        if (!batch.length) {
            break;
        }

        await new Promise((r) => setTimeout(r, HISTORY_PAGE_DELAY_MS));

        for (const msg of batch) {
            if (seenMessageIds.has(msg.message_id)) continue;
            seenMessageIds.add(msg.message_id);
            if (msg.time < startTime) {
                stopLoop = true;
            } else {
                allMessages.push(msg);
            }
        }

        const oldest = batch[0];
        const nextSeq = (oldest as { message_seq?: number }).message_seq ?? oldest.message_id;
        if (nextSeq == null || nextSeq === messageSeq) {
            break;
        }
        messageSeq = nextSeq;

        if (allMessages.length >= limit) {
            break;
        }
    }

    allMessages.sort((a, b) => a.time - b.time);
    return allMessages;
}

export async function connectForward(config: OneBotAccountConfig): Promise<WebSocket> {
    const path = config.path ?? "/onebot/v11/ws";
    const pathNorm = path.startsWith("/") ? path : `/${path}`;

    // 端口为 443 时使用 wss，其余端口使用 ws
    const scheme = config.port === 443 ? "wss" : "ws";
    const addr = `${scheme}://${config.host}:${config.port}${pathNorm}`;

    const headers: Record<string, string> = {};
    if (config.accessToken) {
        headers["Authorization"] = `Bearer ${config.accessToken}`;
    }

    const w = new WebSocket(addr, { headers });
    await new Promise<void>((resolve, reject) => {
        w.on("open", () => resolve());
        w.on("error", reject);
    });
    return w;
}

export async function createServerAndWait(config: OneBotAccountConfig): Promise<WebSocket> {
    const { WebSocketServer } = await import("ws");
    const server = createServer();
    httpServer = server;
    const wss = new WebSocketServer({
        server,
        path: config.path ?? "/onebot/v11/ws",
    });
    const host = config.host || "0.0.0.0";
    server.listen(config.port, host);

    wsServer = wss;

    return new Promise((resolve) => {
        wss.on("connection", (socket: WebSocket) => {
            resolve(socket as WebSocket);
        });
    });
}

export function setWs(socket: WebSocket | null): void {
    ws = socket;
    if (socket && socket.readyState === WebSocket.OPEN && connectionReadyResolve) {
        connectionReadyResolve();
        connectionReadyResolve = null;
    }
}

export function stopConnection(): void {
    if (ws) {
        ws.close();
        ws = null;
    }
    if (wsServer) {
        wsServer.close();
        wsServer = null;
    }
    if (httpServer) {
        httpServer.close();
        httpServer = null;
    }
}
