/**
 * 最近发送消息记录（供「撤回」使用）
 *
 * 记录机器人在每个会话里最近一条自己发出的消息 ID：
 * 主回复（deliver）与 Agent 工具（onebot_send_*）都会写入，
 * onebot_recall 不带 messageId 时用它撤回刚说错的那条。
 */

/** 最多保留的会话条目数，超出按插入顺序淘汰 */
const MAX_ENTRIES = 500;

/** 会话标识（group:123 / user:456）→ 消息 ID */
const lastSent = new Map<string, number>();

/** 归一化会话标识：group:xxx / user:xxx */
export function normalizeRecallTarget(target: string): string {
  const t = String(target ?? "").trim().replace(/^onebot:/i, "");
  return t;
}

/** 记录一条机器人刚发出的消息 ID（messageId 非法则忽略） */
export function noteSentMessage(target: string, messageId: number | string | undefined): void {
  const key = normalizeRecallTarget(target);
  if (!key) return;
  const id = Number(messageId);
  if (!Number.isFinite(id) || id === 0) return;
  if (lastSent.has(key)) lastSent.delete(key);
  lastSent.set(key, id);
  while (lastSent.size > MAX_ENTRIES) {
    const oldest = lastSent.keys().next().value;
    if (oldest === undefined) break;
    lastSent.delete(oldest);
  }
}

/** 取会话里最近一条机器人消息 ID */
export function getLastSentMessage(target: string): number | undefined {
  const key = normalizeRecallTarget(target);
  if (!key) return undefined;
  return lastSent.get(key);
}

/** 撤回成功后清掉记录，避免重复撤回同一个 ID */
export function clearLastSentMessage(target: string, messageId?: number): void {
  const key = normalizeRecallTarget(target);
  if (!key) return;
  if (messageId === undefined || lastSent.get(key) === messageId) lastSent.delete(key);
}

/** 供测试重置 */
export function resetRecallState(): void {
  lastSent.clear();
}
