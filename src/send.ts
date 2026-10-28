/**
 * OneBot 消息发送 — 文本与媒体
 * 对应 Lagrange.onebot context.ts 的 sendPrivateMsg / sendGroupMsg / 图片消息
 */

import {
  sendPrivateMsg,
  sendGroupMsg,
  sendPrivateImage,
  sendGroupImage,
} from "./connection.js";
import { resolveTargetForReply, getForwardSuppressDelivery, isTargetActiveReply, getActiveReplyTarget, getActiveReplySessionId } from "./reply-context.js";
import { logSend } from "./send-debug-log.js";
import { getRenderMarkdownToPlain, getCollapseDoubleNewlines } from "./config.js";
import { markdownToPlain, collapseDoubleNewlines } from "./markdown.js";
import { normalizeAtMarkers } from "./at.js";

export interface OneBotSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

function parseTarget(to: string): { type: "user" | "group"; id: number } | null {
  const t = to.replace(/^(onebot|qq|lagrange):/i, "").trim();
  if (!t) return null;
  if (t.startsWith("group:")) {
    const id = parseInt(t.slice(6), 10);
    if (isNaN(id)) return null;
    return { type: "group", id };
  }
  const raw = t.replace(/^user:/, "");
  const id = parseInt(raw, 10);
  if (isNaN(id)) return null;
  if (raw === t && !t.includes(":")) {
    return { type: id > 100000000 ? "user" : "group", id };
  }
  return { type: "user", id };
}

import type { OneBotAccountConfig } from "./types.js";

type OneBotConfigGetter = () => OneBotAccountConfig | null;

/**
 * 发送文本消息到 OneBot 目标（私聊或群聊）
 * @param getConfig 可选，用于按需连接（forward-websocket 下 message send 可独立运行）
 * @param cfg 可选，用于读取 renderMarkdownToPlain 配置
 */
export async function sendTextMessage(
  to: string,
  text: string,
  getConfig?: OneBotConfigGetter,
  cfg?: { channels?: { onebot?: { renderMarkdownToPlain?: boolean } } },
  replyTo?: string | number
): Promise<OneBotSendResult> {
  const forwardSuppress = getForwardSuppressDelivery();
  const activeTarget = getActiveReplyTarget();
  const suppressed = forwardSuppress && isTargetActiveReply(to);
  logSend("send", "sendTextMessage", {
    to,
    textPreview: text?.slice(0, 80),
    textLen: text?.length,
    suppressed,
    forwardSuppress,
    activeReplyTarget: activeTarget,
    sessionId: activeTarget,
    replySessionId: getActiveReplySessionId(),
  });
  if (suppressed) {
    return { ok: true, messageId: "" };
  }
  const resolvedTo = resolveTargetForReply(to);
  const target = parseTarget(resolvedTo);
  if (!target) {
    return { ok: false, error: `Invalid target: ${to}` };
  }
  if (!text?.trim()) {
    return { ok: false, error: "No text provided" };
  }

  let finalText = getRenderMarkdownToPlain(cfg) ? markdownToPlain(text) : text.trim();
  if (getCollapseDoubleNewlines(cfg)) finalText = collapseDoubleNewlines(finalText);
  // [[at:QQ]] / 空 CQ 码规范化：合法 at 转 CQ 码交由发送层拆成 at 段，空号直接剥除
  finalText = normalizeAtMarkers(finalText).text;

  try {
    let messageId: string | number | undefined;
    if (target.type === "group") {
      messageId = await sendGroupMsg(target.id, finalText, getConfig, replyTo);
    } else {
      messageId = await sendPrivateMsg(target.id, finalText, getConfig, replyTo);
    }
    logSend("send", "sendTextMessage", {
      targetType: target.type,
      targetId: target.id,
      messageId,
      sessionId: activeTarget,
      replySessionId: getActiveReplySessionId(),
    });
    return { ok: true, messageId: messageId != null ? String(messageId) : "" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 发送媒体消息（图片等）到 OneBot 目标
 * mediaUrl 支持 file:// 路径、http(s):// URL、base64://
 * @param getConfig 可选，用于按需连接
 * @param cfg 可选，用于读取 renderMarkdownToPlain 配置
 */
export async function sendMediaMessage(
  to: string,
  mediaUrl: string,
  text?: string,
  getConfig?: OneBotConfigGetter,
  cfg?: { channels?: { onebot?: { renderMarkdownToPlain?: boolean } } }
): Promise<OneBotSendResult> {
  const forwardSuppress = getForwardSuppressDelivery();
  const activeTarget = getActiveReplyTarget();
  const suppressed = forwardSuppress && isTargetActiveReply(to);
  logSend("send", "sendMediaMessage", {
    to,
    textPreview: text?.slice(0, 40),
    mediaUrlPreview: mediaUrl?.slice(0, 60),
    suppressed,
    forwardSuppress,
    activeReplyTarget: activeTarget,
    sessionId: activeTarget,
    replySessionId: getActiveReplySessionId(),
  });
  if (suppressed) {
    return { ok: true, messageId: "" };
  }
  const resolvedTo = resolveTargetForReply(to);
  const target = parseTarget(resolvedTo);
  if (!target) {
    return { ok: false, error: `Invalid target: ${to}` };
  }
  if (!mediaUrl?.trim()) {
    return { ok: false, error: "No mediaUrl provided" };
  }

  let finalText = text?.trim() ? (getRenderMarkdownToPlain(cfg) ? markdownToPlain(text) : text.trim()) : "";
  if (finalText && getCollapseDoubleNewlines(cfg)) finalText = collapseDoubleNewlines(finalText);
  try {
    let messageId: string | number | undefined;
    if (finalText) {
      if (target.type === "group") {
        messageId = await sendGroupMsg(target.id, finalText, getConfig);
      } else {
        messageId = await sendPrivateMsg(target.id, finalText, getConfig);
      }
    }
    if (target.type === "group") {
      const id = await sendGroupImage(target.id, mediaUrl, undefined, getConfig);
      if (id != null) messageId = id;
    } else {
      const id = await sendPrivateImage(target.id, mediaUrl, undefined, getConfig);
      if (id != null) messageId = id;
    }
    logSend("send", "sendMediaMessage", {
      targetType: target.type,
      targetId: target.id,
      messageId,
      sessionId: activeTarget,
      replySessionId: getActiveReplySessionId(),
    });
    return { ok: true, messageId: messageId != null ? String(messageId) : "" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
