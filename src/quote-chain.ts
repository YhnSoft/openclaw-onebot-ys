/**
 * 引用链解析
 *
 * QQ 里可以「引用一条引用了另一条的消息」：3 引用 2、2 引用 1。
 * 这里沿 reply 段一路向上追溯，把整条链一次性取回来拼进上下文，
 * 让模型看到完整的对话来龙去脉，而不是只剩最后一层。
 *
 * 依赖注入 fetchMessage（生产环境为 connection.getMsg），便于单测；
 * 不 import 任何 openclaw 内部模块。
 */

import { getReplyMessageId, getTextFromMessageContent } from "./message.js";
import { toNonNegativeInt } from "./util.js";

export interface QuoteChainEntry {
  /** 消息 ID */
  id: number;
  /** 发送者显示名（昵称 / QQ 号 / 某人） */
  sender: string;
  /** 发送者 QQ 号；取不到时缺省 */
  senderId?: number;
  /** 文本内容；非文本消息会变成 [图片: url] 之类的占位 */
  text: string;
}

export interface QuoteChainOptions {
  /** 起始消息 ID（当前消息直接引用的那条） */
  firstMessageId: number;
  /** get_msg 实现；返回 null 表示取不到 */
  fetchMessage: (id: number) => Promise<unknown | null>;
  /** 最多向上追溯的层数，默认 3；0 或非法值按 1 处理 */
  maxDepth?: number;
  /** 单条文本最大长度，默认 300 */
  maxEntryChars?: number;
  /** 整条链路总字符上限，默认 1200（从最新往前保留） */
  maxTotalChars?: number;
}

const DEFAULT_QUOTE_CHAIN_DEPTH = 3;
const DEFAULT_ENTRY_CHARS = 300;
const DEFAULT_TOTAL_CHARS = 1200;

function clampText(value: unknown, max: number): string {
  const s = String(value ?? "").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/**
 * 取回引用链，返回**由旧到新**的数组（最后一个元素是当前消息直接引用的那条）。
 * 单层时长度为 1；追不到任何消息时返回空数组。
 */
export async function buildQuoteChain(options: QuoteChainOptions): Promise<QuoteChainEntry[]> {
  const fetchMessage = options?.fetchMessage;
  if (typeof fetchMessage !== "function") return [];

  const startId = Number(options?.firstMessageId);
  // QQ NT / NapCat 的 message_id 可能是负数（int32），负数同样合法，只有 0/NaN 视为无效
  if (!Number.isFinite(startId) || startId === 0) return [];

  const depthRaw = toNonNegativeInt(options?.maxDepth, DEFAULT_QUOTE_CHAIN_DEPTH);
  const maxDepth = Math.max(1, depthRaw === 0 ? 1 : depthRaw);
  const maxEntryChars = Math.max(20, toNonNegativeInt(options?.maxEntryChars, DEFAULT_ENTRY_CHARS) || DEFAULT_ENTRY_CHARS);
  const maxTotalChars = Math.max(40, toNonNegativeInt(options?.maxTotalChars, DEFAULT_TOTAL_CHARS) || DEFAULT_TOTAL_CHARS);

  const visited = new Set<number>();
  const entries: QuoteChainEntry[] = [];
  let cursor: number | undefined = startId;

  // 从当前引用的那条开始，一路往上（时间上更早）
  while (cursor != null && entries.length < maxDepth) {
    if (visited.has(cursor)) break; // 自引用或成环
    visited.add(cursor);

    let quoted: any = null;
    try {
      quoted = await fetchMessage(cursor);
    } catch {
      break;
    }
    if (!quoted) break;

    const senderRaw = quoted?.sender?.nickname ?? quoted?.sender?.user_id ?? "某人";
    const senderIdNum = Number(quoted?.sender?.user_id ?? quoted?.user_id);
    const textRaw = getTextFromMessageContent(quoted?.message)?.trim() ?? "";
    entries.push({
      id: cursor,
      sender: clampText(senderRaw, 40),
      ...(Number.isFinite(senderIdNum) && senderIdNum > 0 ? { senderId: senderIdNum } : {}),
      text: clampText(textRaw || "[非文本消息]", maxEntryChars),
    });

    const next = getReplyMessageId(quoted);
    if (next == null || next === cursor) break;
    cursor = next;
  }

  entries.reverse(); // 由旧到新

  // 总量控制：优先保留靠后的（更接近当前上下文）
  const kept: QuoteChainEntry[] = [];
  let total = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (kept.length > 0 && total + entry.text.length > maxTotalChars) break;
    kept.unshift(entry);
    total += entry.text.length;
  }
  return kept;
}

/**
 * 把引用链格式化成给模型看的文本块。
 * 单层保持原样 `[引用 X 的消息：...]`；多层带序号，由旧到新。
 */
export function formatQuoteChain(chain: QuoteChainEntry[]): string {
  if (!Array.isArray(chain) || chain.length === 0) return "";
  if (chain.length === 1) {
    const only = chain[0]!;
    return `[引用 ${only.sender} 的消息（#${only.id}）：${only.text}]`;
  }
  const lines = chain.map((entry, index) => `${index + 1}. [#${entry.id}] ${entry.sender}：${entry.text}`);
  return `[引用链（由旧到新，共 ${chain.length} 条）]\n${lines.join("\n")}`;
}

/** 引用链的纯文本（给判定器 / 历史记录用） */
export function quoteChainToText(chain: QuoteChainEntry[]): string {
  if (!Array.isArray(chain) || chain.length === 0) return "";
  return chain.map((entry) => `${entry.sender}：${entry.text}`).join("\n");
}

/**
 * 当前消息是否**直接引用**了机器人自己的发言。
 *
 * 只认「直接引用的那一条」（链尾）——3 引用 2、2 引用 1 时，即使 1 是机器人发的，
 * 3 引用的也是 2，不算在跟机器人说话。用于群聊放行：被引用 = 明确的对话对象，
 * 应当和 @ 一样立即回复，不消耗 LLM 判定。
 */
export function quoteTargetIsSelf(chain: QuoteChainEntry[], selfId: number | undefined): boolean {
  if (!Array.isArray(chain) || chain.length === 0) return false;
  const id = Number(selfId);
  if (!Number.isFinite(id) || id <= 0) return false;
  const target = chain[chain.length - 1];
  const senderId = Number(target?.senderId);
  return Number.isFinite(senderId) && senderId === id;
}
