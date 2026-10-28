/**
 * 发送调试日志：记录所有文字/媒体发送相关的关键信息，便于排查
 * 日志路径：项目根目录的绝对路径 send-debug.log
 * 启用：设置环境变量 OPENCLAW_ONEBOT_SEND_DEBUG=1
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 绝对路径：openclaw-onebot/send-debug.log，运行前设置 OPENCLAW_ONEBOT_SEND_DEBUG=1 启用 */
export const SEND_DEBUG_LOG_PATH = path.resolve(__dirname, "..", "send-debug.log");

function isEnabled(): boolean {
  return process.env.OPENCLAW_ONEBOT_SEND_DEBUG === "1";
}

let sessionLogged = false;

export function logSend(
  layer: "send" | "connection",
  fn: string,
  data: {
    targetType?: "group" | "user" | "to";
    targetId?: number | string;
    to?: string;
    textPreview?: string;
    textLen?: number;
    suppressed?: boolean;
    forwardSuppress?: boolean;
    activeReplyTarget?: string | null;
    /** 会话 ID，如 onebot:group:123 */
    sessionId?: string | null;
    /** 回复会话 ID，同一问题下多次 deliver 共享 */
    replySessionId?: string | null;
    messageId?: number | string;
    /** 本次发送引用的消息 ID */
    replyTo?: number | string;
    isForward?: boolean;
    nodeCount?: number;
    imagePreview?: string;
    mediaUrlPreview?: string;
    blocked?: boolean;
  }
): void {
  if (!isEnabled()) return;
  try {
    if (!sessionLogged) {
      fs.appendFileSync(
        SEND_DEBUG_LOG_PATH,
        `${new Date().toISOString()} [session] 日志路径(绝对): ${SEND_DEBUG_LOG_PATH}\n`
      );
      sessionLogged = true;
    }
    const line = `${new Date().toISOString()} [${layer}] ${fn} ${JSON.stringify(data)}\n`;
    fs.appendFileSync(SEND_DEBUG_LOG_PATH, line);
  } catch (_) {}
}
