/**
 * OneBot Channel 插件定义
 * 仿照 openclaw-feishu channel.ts 结构，接入 OneBot v11 协议（QQ/Lagrange.Core/go-cqhttp）
 *
 * 对应 Lagrange.onebot context.ts 的 API：
 * - sendPrivateMsg / sendGroupMsg / sendMsg
 * - sendGroupImage / sendPrivateImage（图片）
 * - deleteMsg / getMsg / getGroupMsgHistory
 * - uploadGroupFile / uploadPrivateFile
 */

import { getOneBotConfig, listAccountIds } from "./config.js";
import { sendTextMessage, sendMediaMessage } from "./send.js";
import { startOneBotService, stopOneBotService, resetOneBotService } from "./service.js";
import { getWs } from "./connection.js";

const meta = {
    id: "onebot",
    label: "OneBot",
    selectionLabel: "OneBot (QQ/Lagrange)",
    docsPath: "/channels/onebot",
    docsLabel: "onebot",
    blurb: "OneBot v11 protocol via WebSocket (go-cqhttp, Lagrange.Core)",
    aliases: ["qq", "lagrange", "cqhttp"],
    order: 85,
};

function oneBotSection(cfg: any): any {
    const section = cfg?.channels?.onebot;
    return section && typeof section === "object" ? section : {};
}

/** 取某个账号的有效配置（账号级优先，其次渠道根配置）。 */
function oneBotAccountConfig(cfg: any, accountId?: string): any {
    const section = oneBotSection(cfg);
    const id = accountId ?? "default";
    const account = section.accounts?.[id];
    return account && typeof account === "object" ? { ...section, ...account, accounts: undefined } : section;
}

function isAccountConfigured(cfg: any, accountId?: string): boolean {
    const config = oneBotAccountConfig(cfg, accountId);
    return Boolean(config?.host) && Boolean(config?.port);
}

function isAccountEnabled(cfg: any, accountId?: string): boolean {
    const section = oneBotSection(cfg);
    const account = section.accounts?.[accountId ?? "default"];
    return section.enabled !== false && account?.enabled !== false;
}

/**
 * OpenClaw 2026.x 会把“适配器返回空消息 ID”判定为 adapter_returned_no_identity 并丢弃回执。
 * 部分 OneBot 实现（或代理层）的 send_* 响应不带 message_id，
 * 这里为成功发送补一个本地回执 ID，避免误判为发送被抑制。
 */
let outboundIdentitySeq = 0;
function ensureOutboundIdentity(messageId: string | undefined, kind: "text" | "media"): string {
    const trimmed = messageId?.trim();
    if (trimmed) return trimmed;
    const id = `onebot-${kind}-${Date.now()}-${++outboundIdentitySeq}`;
    try {
        console.warn(`[onebot] OneBot 响应未包含 message_id，已生成本地回执 ID ${id}`);
    } catch {
        /* ignore logging errors */
    }
    return id;
}

function normalizeOneBotMessagingTarget(raw: string): string | undefined {
    const trimmed = raw?.trim();
    if (!trimmed) return undefined;
    return trimmed.replace(/^(onebot|qq|lagrange):/i, "").trim();
}

/** 从模型/框架给的引用目标里提取真正的 OneBot 消息 id（纯数字，可能为负） */
function extractQuoteId(value: string | number | undefined): string | undefined {
    if (value == null) return undefined;
    const m = String(value).match(/-?\d+/);
    return m ? m[0] : undefined;
}

// 注：目标解析（group:/user:/裸 QQ 号）在 send.ts 的 parseTarget 中实现，此处不再重复。

export const OneBotChannelPlugin = {
    id: "onebot",
    meta: {
        ...meta,
        id: meta.id,
        label: meta.label,
        selectionLabel: meta.selectionLabel,
        docsPath: meta.docsPath,
        blurb: meta.blurb,
        aliases: meta.aliases,
    },
    capabilities: {
        chatTypes: ["direct", "group"] as const,
        media: true,
        reactions: false,
        threads: false,
        polls: false,
    },
    reload: { configPrefixes: ["channels.onebot"] as const },
    config: {
        listAccountIds: (cfg: any) => listAccountIds(cfg),
        defaultAccountId: (cfg: any) => {
            const ids = listAccountIds(cfg);
            return ids.includes("default") ? "default" : (ids[0] ?? "default");
        },
        resolveAccount: (cfg: any, accountId?: string) => {
            const id = accountId ?? "default";
            const acc = cfg?.channels?.onebot?.accounts?.[id];
            if (acc) return { accountId: id, ...acc };
            const ch = cfg?.channels?.onebot;
            if (ch?.host) return { accountId: id, ...ch };
            return { accountId: id };
        },
        // 供 channels list / status / Control UI 在只读路径判断账号状态
        inspectAccount: (cfg: any, accountId?: string) => {
            const id = accountId ?? "default";
            const configured = isAccountConfigured(cfg, id);
            return {
                enabled: isAccountEnabled(cfg, id),
                configured,
                ...(configured ? {} : { unconfiguredReason: "host/port 未配置" }),
            };
        },
        isEnabled: (account: any, cfg: any) => {
            const id = account?.accountId ?? "default";
            return isAccountEnabled(cfg, id);
        },
        isConfigured: (account: any, cfg: any) => isAccountConfigured(cfg, account?.accountId),
        hasConfiguredState: ({ cfg }: { cfg: any }) => Boolean(getOneBotConfig({ config: cfg }, "default")),
        setAccountEnabled: ({ cfg, accountId, enabled }: { cfg: any; accountId?: string; enabled: boolean }) => {
            const next = { ...cfg, channels: { ...(cfg?.channels ?? {}) } };
            const section = { ...oneBotSection(cfg) };
            const id = accountId ?? "default";
            if (id === "default") {
                section.enabled = enabled;
            } else {
                const accounts = { ...(section.accounts ?? {}) };
                accounts[id] = { ...(accounts[id] ?? {}), enabled };
                section.accounts = accounts;
            }
            next.channels.onebot = section;
            return next;
        },
        deleteAccount: ({ cfg, accountId }: { cfg: any; accountId?: string }) => {
            const next = { ...cfg, channels: { ...(cfg?.channels ?? {}) } };
            const section = { ...oneBotSection(cfg) };
            const id = accountId ?? "default";
            if (id === "default") {
                delete next.channels.onebot;
                return next;
            }
            if (section.accounts) {
                const accounts = { ...section.accounts };
                delete accounts[id];
                section.accounts = accounts;
            }
            next.channels.onebot = section;
            return next;
        },
    },
    // 支持 openclaw channels add / Control UI 原生配置写入（不需要插件自有 TUI）
    setup: {
        validateInput: ({ input }: { input: any }) => {
            if (input?.type != null && !["forward-websocket", "backward-websocket"].includes(String(input.type))) {
                return "type 必须是 forward-websocket 或 backward-websocket";
            }
            if (input?.port != null) {
                const port = Number(input.port);
                if (!Number.isInteger(port) || port < 1 || port > 65535) {
                    return "port 必须是 1-65535 的整数";
                }
            }
            if (input?.host != null && (typeof input.host !== "string" || !input.host.trim())) {
                return "host 必须是非空字符串";
            }
            if (!input?.host || input?.port == null) {
                return "需要提供 --host 和 --port（例如 --host 127.0.0.1 --port 3001）";
            }
            return null as string | null;
        },
        applyAccountConfig: ({ cfg, accountId, input }: { cfg: any; accountId?: string; input: any }) => {
            const fields: Record<string, unknown> = {};
            if (input?.type) fields.type = String(input.type);
            if (input?.host) fields.host = String(input.host).trim();
            if (input?.port != null) fields.port = Number(input.port);
            const token = input?.accessToken ?? input?.token;
            if (token) fields.accessToken = String(token).trim();
            if (input?.path) fields.path = String(input.path).trim();

            const channels = { ...(cfg?.channels ?? {}) };
            const section = { ...oneBotSection(cfg) };
            const id = accountId ?? "default";
            if (id === "default") {
                channels.onebot = { ...section, ...fields, enabled: true };
            } else {
                const accounts = { ...(section.accounts ?? {}) };
                accounts[id] = { ...(accounts[id] ?? {}), ...fields, enabled: true };
                channels.onebot = { ...section, accounts };
            }

            // 外部插件在 OpenClaw 2026.x 需要显式启用条目，否则 Gateway 不会加载插件。
            const plugins = { ...(cfg?.plugins ?? {}) };
            const entries = { ...(plugins.entries ?? {}) };
            entries["openclaw-onebot"] = { ...(entries["openclaw-onebot"] ?? {}), enabled: true };
            plugins.entries = entries;
            if (Array.isArray(plugins.allow) && plugins.allow.length > 0) {
                const allow = plugins.allow.map((id: unknown) => String(id));
                if (!allow.includes("openclaw-onebot")) allow.push("openclaw-onebot");
                plugins.allow = allow;
            }
            if (Array.isArray(plugins.deny)) {
                plugins.deny = plugins.deny.map((id: unknown) => String(id)).filter((id: string) => id !== "openclaw-onebot");
            }

            return { ...cfg, plugins, channels };
        },
    },
    // OpenClaw 2026.x 的频道账号生命周期：让 channels status/health-monitor 认为频道正在运行
    gateway: {
        startAccount: async (ctx: any) => {
            const api = (globalThis as any).__onebotApi ?? { config: ctx?.cfg, logger: ctx?.log };
            const accountId = ctx?.accountId ?? ctx?.account?.accountId ?? "default";
            const config = getOneBotConfig(api, accountId);
            if (!config) throw new Error("OneBot 未配置（缺少 channels.onebot.host/port）");
            await startOneBotService(api);
            ctx?.setStatus?.({
                accountId,
                running: true,
                connected: true,
                lifecycle: "ready",
                lastConnectedAt: Date.now(),
                lastError: null,
            });

            // 频道账号生命周期需要保持运行：连接关闭或收到 abort 时才结束，
            // 否则 OpenClaw 会认为 "channel exited" 并反复重启频道。
            await new Promise<void>((resolve) => {
                let settled = false;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    resetOneBotService();
                    resolve();
                };
                const signal = ctx?.abortSignal;
                if (signal?.aborted) {
                    finish();
                    return;
                }
                signal?.addEventListener?.("abort", finish, { once: true });
                const socket = getWs();
                if (!socket) {
                    finish();
                    return;
                }
                socket.once("close", finish);
            });
        },
        stopAccount: async (ctx: any) => {
            stopOneBotService((globalThis as any).__onebotApi);
            ctx?.setStatus?.({
                accountId: ctx?.accountId ?? "default",
                running: false,
                connected: false,
                lifecycle: "stopped",
            });
        },
    },
    groups: {
        resolveRequireMention: () => true,
    },
    messaging: {
        normalizeTarget: normalizeOneBotMessagingTarget,
        targetResolver: {
            looksLikeId: (raw: string) => {
                // 允许 onebot:/qq:/lagrange: 前缀（OpenClaw message 工具会带上 ctx 里的完整 target）
                const trimmed = raw.trim().replace(/^(onebot|qq|lagrange):/i, "").trim();
                if (!trimmed) return false;
                return /^group:\d+$/.test(trimmed) || /^user:\d+$/.test(trimmed) || /^\d{6,}$/.test(trimmed);
            },
            hint: "user:<QQ号> 或 group:<群号>（也支持 onebot:group:<群号> / onebot:user:<QQ号>）",
        },
    },
    outbound: {
        deliveryMode: "direct" as const,
        chunker: (text: string, limit: number) => {
            if (!text) return [];
            if (limit <= 0 || text.length <= limit) return [text];
            const chunks: string[] = [];
            let remaining = text;
            while (remaining.length > limit) {
                const window = remaining.slice(0, limit);
                const lastNewline = window.lastIndexOf("\n");
                const lastSpace = window.lastIndexOf(" ");
                let breakIdx = lastNewline > 0 ? lastNewline : lastSpace;
                if (breakIdx <= 0) breakIdx = limit;
                const rawChunk = remaining.slice(0, breakIdx);
                const chunk = rawChunk.trimEnd();
                if (chunk.length > 0) chunks.push(chunk);
                const brokeOnSeparator = breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
                const nextStart = Math.min(remaining.length, breakIdx + (brokeOnSeparator ? 1 : 0));
                remaining = remaining.slice(nextStart).trimStart();
            }
            if (remaining.length) chunks.push(remaining);
            return chunks;
        },
        chunkerMode: "text" as const,
        textChunkLimit: 4000,
        resolveTarget: ({ to }: { to?: string }) => {
            const t = to?.trim();
            if (!t) return { ok: false, error: new Error("OneBot requires --to <user_id|group_id>") };
            return { ok: true, to: t };
        },
        sendText: async ({ to, text, accountId, cfg, replyTo, replyToId }: { to: string; text: string; accountId?: string; cfg?: any; replyTo?: string | number; replyToId?: string | number }) => {
            const api = cfg ? { config: cfg } : (globalThis as any).__onebotApi;
            const config = getOneBotConfig(api, accountId);
            if (!config) {
                return { channel: "onebot", ok: false, messageId: "", error: new Error("OneBot not configured") };
            }
            const getConfig = () => getOneBotConfig(api, accountId);
            const quotedId = extractQuoteId(replyTo ?? replyToId);
            try {
                const result = await sendTextMessage(to, text, getConfig, cfg, quotedId);
                if (!result.ok) {
                    return { channel: "onebot", ok: false, messageId: "", error: new Error(result.error) };
                }
                return { channel: "onebot", ok: true, messageId: ensureOutboundIdentity(result.messageId, "text") };
            } catch (e) {
                return { channel: "onebot", ok: false, messageId: "", error: e instanceof Error ? e : new Error(String(e)) };
            }
        },
        sendMedia: async (params: {
            to: string;
            text?: string;
            mediaUrl?: string;
            media?: string;
            accountId?: string;
            cfg?: any;
        }) => {
            const { to, text, accountId, cfg } = params;
            const mediaUrl = params.mediaUrl ?? params.media;
            const api = cfg ? { config: cfg } : (globalThis as any).__onebotApi;
            const config = getOneBotConfig(api, accountId);
            if (!config) {
                return { channel: "onebot", ok: false, messageId: "", error: new Error("OneBot not configured") };
            }
            if (!mediaUrl?.trim()) {
                return { channel: "onebot", ok: false, messageId: "", error: new Error("mediaUrl is required") };
            }
            const getConfig = () => getOneBotConfig(api, accountId);
            try {
                const result = await sendMediaMessage(to, mediaUrl, text, getConfig, cfg);
                if (!result.ok) {
                    return { channel: "onebot", ok: false, messageId: "", error: new Error(result.error) };
                }
                return { channel: "onebot", ok: true, messageId: ensureOutboundIdentity(result.messageId, "media") };
            } catch (e) {
                return { channel: "onebot", ok: false, messageId: "", error: e instanceof Error ? e : new Error(String(e)) };
            }
        },
    },
};
