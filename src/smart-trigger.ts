/**
 * OneBot 智能触发（两段式）
 *
 * 第一段（零 token）：关键词 / 机器人别名直通。
 * 第二段（LLM）：调用宿主 `api.runtime.llm.complete` 判断是否接话。
 *
 * 成本护栏：同群「判定最小间隔 / 回复冷却 / 每小时上限」，全部为模块级状态。
 * 本模块不 import 任何 openclaw 内部模块，也不读取 provider key / accessToken。
 */

import type { SmartTriggerConfig } from "./config.js";

/** 每小时窗口 */
const HOUR_MS = 3600000;
/** 清理定时器间隔：10 分钟 */
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
/** 群状态保留时长：2 小时 */
const STALE_MS = 2 * HOUR_MS;
/** 单条历史消息截断长度 */
const HISTORY_ENTRY_CHARS = 200;
/** 错误信息最大长度 */
const ERROR_CHARS = 200;

/**
 * 判定器默认人设摘要（可用 smartTrigger.judgePersona 覆盖）。
 * 只用于让判定器理解「这是谁、别人怎么称呼它」，不替代主回复的人设。
 */
const DEFAULT_JUDGE_PERSONA =
  "一只叫「小鲸鱼」的 QQ 群聊机器人，网友也叫它「大肥鱼」「鲸鱼娘」「鲸宝」，它的 QQ 昵称是「辉の大肥鱼」——别人这么叫就是在叫它。性格傲娇嘴硬、话短、懒得营业，正事上靠谱；不是客服、不是助手、也不是气氛组。";

/** 最近一次 LLM 判定时间（groupId → ts） */
const lastJudgeAt = new Map<number, number>();
/** 最近一次放行回复时间（groupId → ts） */
const lastReplyAt = new Map<number, number>();
/** 每小时放行时间戳（groupId → ts[]） */
const replyTimestamps = new Map<number, number[]>();
/** 正在进行 LLM 判定的群（并发保护用） */
const judgeInFlight = new Set<number>();

/** 清理超过 2 小时的群状态 */
function pruneStaleState(now: number): void {
  for (const [group, ts] of lastJudgeAt) {
    if (now - ts > STALE_MS) lastJudgeAt.delete(group);
  }
  for (const [group, ts] of lastReplyAt) {
    if (now - ts > STALE_MS) lastReplyAt.delete(group);
  }
  for (const [group, list] of replyTimestamps) {
    const kept = list.filter((ts) => now - ts <= STALE_MS);
    if (kept.length === 0) replyTimestamps.delete(group);
    else replyTimestamps.set(group, kept);
  }
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/** 模块级清理定时器（unref，不阻止进程退出） */
function ensureCleanupTimer(): void {
  if (cleanupTimer) return;
  if (typeof setInterval !== "function") return;
  try {
    cleanupTimer = setInterval(() => {
      try {
        pruneStaleState(Date.now());
      } catch {
        /* 清理失败不影响主流程 */
      }
    }, CLEANUP_INTERVAL_MS);
    (cleanupTimer as any)?.unref?.();
  } catch {
    cleanupTimer = null;
  }
}

ensureCleanupTimer();

/** 文本归一化：小写 + 压缩空白，用于关键词/别名匹配 */
function normalizeForMatch(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** 直通匹配：keywords + aliases，命中返回匹配到的词，否则 null。 */
export function matchDirectTrigger(text: string, smart: SmartTriggerConfig): string | null {
  if (typeof text !== "string") return null;
  const haystack = normalizeForMatch(text).trim();
  if (!haystack) return null;

  const keywords = Array.isArray(smart?.keywords) ? smart.keywords : [];
  for (const keyword of keywords) {
    if (typeof keyword !== "string") continue;
    const needle = normalizeForMatch(keyword).trim();
    if (!needle) continue;
    const hit = smart?.keywordMode === "prefix" ? haystack.startsWith(needle) : haystack.includes(needle);
    if (hit) return keyword;
  }

  const aliases = Array.isArray(smart?.aliases) ? smart.aliases : [];
  for (const alias of aliases) {
    if (typeof alias !== "string") continue;
    const needle = normalizeForMatch(alias).trim();
    if (!needle) continue;
    if (haystack.includes(needle)) return alias;
  }

  return null;
}

/** 成本护栏检查（纯函数 + 模块级状态读取）。 */
export function checkSmartTriggerGuards(
  smart: SmartTriggerConfig,
  groupId: number,
  now?: number,
): { allowed: boolean; reason?: "min-interval" | "cooldown" | "hourly-limit" } {
  const t = typeof now === "number" && Number.isFinite(now) ? now : Date.now();

  // 1) 同群两次 LLM 判定最小间隔
  const minIntervalMs = typeof smart?.minIntervalMs === "number" ? smart.minIntervalMs : 0;
  if (minIntervalMs > 0) {
    const last = lastJudgeAt.get(groupId);
    if (last !== undefined && t - last < minIntervalMs) {
      return { allowed: false, reason: "min-interval" };
    }
  }

  // 2) 放行回复后的同群冷却
  const cooldownMs = typeof smart?.cooldownMs === "number" ? smart.cooldownMs : 0;
  if (cooldownMs > 0) {
    const last = lastReplyAt.get(groupId);
    if (last !== undefined && t - last < cooldownMs) {
      return { allowed: false, reason: "cooldown" };
    }
  }

  // 3) 每小时放行上限（0 = 不限）
  const maxRepliesPerHour = typeof smart?.maxRepliesPerHour === "number" ? smart.maxRepliesPerHour : 0;
  if (maxRepliesPerHour > 0) {
    const list = replyTimestamps.get(groupId) ?? [];
    const recent = list.filter((ts) => t - ts < HOUR_MS);
    if (recent.length >= maxRepliesPerHour) {
      return { allowed: false, reason: "hourly-limit" };
    }
  }

  return { allowed: true };
}

/** 记录一次 LLM 判定发生（更新 minInterval 时间戳）。 */
export function noteSmartTriggerJudge(groupId: number, now?: number): void {
  const t = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  lastJudgeAt.set(groupId, t);
}

/** 记录一次「放行回复」（更新 cooldown 与每小时计数）。 */
export function noteSmartTriggerReply(groupId: number, now?: number): void {
  const t = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  lastReplyAt.set(groupId, t);
  const list = (replyTimestamps.get(groupId) ?? []).filter((ts) => t - ts < HOUR_MS);
  list.push(t);
  replyTimestamps.set(groupId, list);
}

/** 供单测重置模块级状态。 */
export function resetSmartTriggerState(): void {
  lastJudgeAt.clear();
  lastReplyAt.clear();
  replyTimestamps.clear();
  judgeInFlight.clear();
}

/**
 * 原子获取同群判定权：护栏通过且无并发判定时占用并记录 judge 时间。
 * 调用方必须在 finally 中调用 endSmartTriggerJudge(groupId)。
 */
export function beginSmartTriggerJudge(
  smart: SmartTriggerConfig,
  groupId: number,
  now?: number,
): { allowed: boolean; reason?: "min-interval" | "cooldown" | "hourly-limit" | "in-flight" } {
  const guard = checkSmartTriggerGuards(smart, groupId, now);
  if (!guard.allowed) return guard;

  // 同一时刻只允许一条消息在该群走 LLM 判定
  if (judgeInFlight.has(groupId)) return { allowed: false, reason: "in-flight" };

  judgeInFlight.add(groupId);
  noteSmartTriggerJudge(groupId, now);
  return { allowed: true };
}

/** 释放判定权（调用方在 finally 中调用）。 */
export function endSmartTriggerJudge(groupId: number): void {
  judgeInFlight.delete(groupId);
}

/**
 * 直通触发去重：同群 `minIntervalMs` 内重复命中触发词时只放行一次，避免连发刷屏。
 * 直通不消耗 LLM，但仍会影响后续 LLM 判定的最小间隔（共用 lastJudgeAt）。
 */
export function shouldSkipDirectTrigger(smart: SmartTriggerConfig, groupId: number, now?: number): boolean {
  const t = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const minIntervalMs = typeof smart?.minIntervalMs === "number" ? smart.minIntervalMs : 0;
  if (minIntervalMs <= 0) return false;
  const last = lastJudgeAt.get(groupId);
  return last !== undefined && t - last < minIntervalMs;
}

/** 记录一次直通触发时间（与 LLM 判定共用 lastJudgeAt）。 */
export function noteDirectTrigger(groupId: number, now?: number): void {
  noteSmartTriggerJudge(groupId, now);
}

/** 补齐缺失/非法字段的防御式配置（供直接调用工具的调用方兜底）。 */
function normalizeSmart(smart: SmartTriggerConfig): SmartTriggerConfig {
  const src: any = smart ?? {};
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  return {
    enabled: src.enabled === true,
    groups: Array.isArray(src.groups) ? src.groups : [],
    keywords: Array.isArray(src.keywords) ? src.keywords : [],
    keywordMode: src.keywordMode === "prefix" ? "prefix" : "contains",
    aliases: Array.isArray(src.aliases) ? src.aliases : [],
    threshold: num(src.threshold, 0.6),
    timeoutMs: num(src.timeoutMs, 8000),
    minIntervalMs: num(src.minIntervalMs, 3000),
    cooldownMs: num(src.cooldownMs, 30000),
    maxRepliesPerHour: num(src.maxRepliesPerHour, 6),
    historyLimit: num(src.historyLimit, 10),
    maxInputChars: num(src.maxInputChars, 2000),
    model: typeof src.model === "string" ? src.model : "",
    fallback: src.fallback === "reply" ? "reply" : "ignore",
    minMessageChars: num(src.minMessageChars, 2),
    allowModelSilence: src.allowModelSilence === true,
    silentMarker: typeof src.silentMarker === "string" && src.silentMarker.trim() ? src.silentMarker.trim() : "[[silent]]",
    sassEnabled: src.sassEnabled === undefined ? true : src.sassEnabled === true,
    sassStyle: typeof src.sassStyle === "string" ? src.sassStyle.trim() : "",
    judgePersona: typeof src.judgePersona === "string" ? src.judgePersona.trim() : "",
  };
}

/** 截断到 n 个字符，超长加省略号 */
function clampText(text: string, n: number): string {
  const s = String(text ?? "");
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

/** 构造判定提示词（导出便于单测）。 */
export function buildJudgePrompt(params: {
  smart: SmartTriggerConfig;
  senderLabel: string;
  messageText: string;
  recentMessages: Array<{ sender: string; body: string }>;
  quotedText?: string;
  aliases: string[];
  /** 本条消息 @ 的目标 QQ：让判定器区分「在叫机器人」和「在叫别的群友」 */
  atTargets?: Array<number | { qq: number; name?: string }>;
  /** 机器人自己的 QQ，用于标注 @ 目标里谁是机器人 */
  selfId?: number;
}): { systemPrompt: string; userPrompt: string } {
  const smart = normalizeSmart(params?.smart as SmartTriggerConfig);
  const maxInputChars = Math.max(200, Math.floor(smart.maxInputChars));
  const historyLimit = Math.max(0, Math.min(30, Math.floor(smart.historyLimit)));

  const persona = (smart.judgePersona || DEFAULT_JUDGE_PERSONA).trim();
  const systemPrompt = [
    `【机器人是谁】${persona}`,
    "",
    "你是 QQ 群聊里的「接话判定器」。你的唯一职责是：站在这个机器人的立场，判断它此刻是否该在这条群消息上开口。",
    "只输出一个 JSON 对象，不要输出任何解释，也不要使用 Markdown 代码块：",
    smart.sassEnabled
      ? '{"reply":true或false,"confidence":0到1之间的小数,"intent":"answer"或"sass","reason":"简短中文理由，不超过30字"}'
      : '{"reply":true或false,"confidence":0到1之间的小数,"reason":"简短中文理由，不超过30字"}',
    "",
    "判定规则：",
    smart.sassEnabled
      ? "1. 消息直接向机器人提问、求助、点名机器人，或明确需要机器人回答 → reply=true，intent=\"answer\"，confidence 取 0.8 以上；"
      : "1. 消息直接向机器人提问、求助、点名机器人，或明确需要机器人回答 → reply=true，confidence 取 0.8 以上；",
    smart.sassEnabled
      ? "2. 消息在延续机器人之前参与过的话题（追问、补充、反驳机器人的说法）→ reply=true，intent=\"answer\"，confidence 取 0.6~0.8；"
      : "2. 消息在延续机器人之前参与过的话题（追问、补充、反驳机器人的说法）→ reply=true，confidence 取 0.6~0.8；",
    smart.sassEnabled
      ? "3. 群友之间的日常闲聊、互相打招呼、与机器人无关的话题 → reply=false（除非属于规则 6 的吐槽素材）；"
      : "3. 群友之间的日常闲聊、互相打招呼、与机器人无关的话题 → reply=false；",
    "4. 涉及敏感话题、隐私、争吵、人身攻击，或要求机器人站队/表态 → reply=false；",
    "5. 前文信息不足、拿不准时一律 reply=false（宁可错过，不要打扰）",
    smart.sassEnabled
      ? "6. 轻松氛围下的「可吐槽素材」：群友自嘲、吹牛立 flag、离谱翻车、抽象整活、玩梗求接梗、阴阳怪气但不伤人 → reply=true，intent=\"sass\"，confidence 取 0.65~0.85；吐槽要短、准、有梗，就事论事，不带恶意；"
      : null,
    smart.sassEnabled
      ? "7. 如果吐槽可能冒犯当事人、把玩笑变成攻击，或群里正在争吵、气氛紧张 → reply=false；"
      : null,
    "补充判断（按这个机器人的性格来）：",
    "· 先看对象：这条消息 @ 了谁、引用的是谁的消息、在回应谁。如果它在跟其他群友说话（@了别人、或明显是两人在互动），机器人只是在旁边看着 → reply=false。",
    "· 什么才算在叫它：@ 机器人自己、引用机器人的消息、或提到它的名字/昵称（小鲸鱼、大肥鱼、鲸鱼、鲸宝等）。",
    "· 认 QQ 不认名字：群里完全可能有别人昵称里也带「大肥鱼」「鲸鱼」这类词。判断时以 QQ 号为准——只有【机器人自己的 QQ】那个号才是它；【本条消息 @ 了】里标注为「其他群友」的目标，就是在叫别人，不是叫它。",
    "· 它话短、懒得营业但不冷漠：不请自来地插进别人的对话是最失礼的事，没被叫到时默认沉默；只有明显在逗它、或话题确实跟它有关时才开口。",
    "",
    smart.sassEnabled
      ? "confidence 表示你对 reply 判断的把握程度（0~1）。intent 表示接话方式：answer=认真回答/帮忙，sass=吐槽/接梗。reason 用一句话说明理由。"
      : "confidence 表示你对 reply 判断的把握程度（0~1）。reason 用一句话说明理由。",
  ].filter((line): line is string => line !== null).join("\n");

  // 最近消息：从最新往前累加，总量不超过 maxInputChars
  const recent = Array.isArray(params?.recentMessages) ? params.recentMessages.slice(-historyLimit) : [];
  const lines: string[] = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const entry: any = recent[i] ?? {};
    const sender = clampText(String(entry.sender ?? "未知").trim() || "未知", 40);
    const body = clampText(String(entry.body ?? "").replace(/\s+/g, " ").trim(), HISTORY_ENTRY_CHARS);
    if (!body) continue;
    const line = `${sender}: ${body}`;
    if (used + line.length + 1 > maxInputChars) break;
    lines.unshift(line);
    used += line.length + 1;
  }

  const aliases = (Array.isArray(params?.aliases) ? params.aliases : [])
    .filter((a: unknown): a is string => typeof a === "string" && a.trim().length > 0)
    .map((a) => a.trim());

  const senderLabel = clampText(String(params?.senderLabel ?? "").trim() || "某人", 40);
  const messageText = clampText(String(params?.messageText ?? "").trim(), maxInputChars);
  const quotedText = clampText(String(params?.quotedText ?? "").trim(), Math.min(maxInputChars, 500));

  const now = new Date();
  const timeLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const parts: string[] = [];
  if (aliases.length > 0) {
    parts.push(`【机器人别名】${aliases.join("、")}`);
  }
  parts.push(`【当前时间】${timeLabel}`);
  if (lines.length > 0) {
    parts.push(`【最近群聊记录】（由旧到新）\n${lines.join("\n")}`);
  }
  if (quotedText) {
    parts.push(`【被引用的消息】\n${quotedText}`);
  }
  const selfIdNum = Number(params?.selfId ?? 0);
  const atTargets = (Array.isArray(params?.atTargets) ? params.atTargets : [])
    .map((t: unknown): { qq: number; name: string } | null => {
      if (typeof t === "number") {
        return Number.isFinite(t) ? { qq: t, name: "" } : null;
      }
      const obj = t as { qq?: unknown; name?: unknown } | null;
      const qq = Number(obj?.qq);
      if (!Number.isFinite(qq)) return null;
      const name = typeof obj?.name === "string" ? obj.name.trim() : "";
      return { qq, name };
    })
    .filter((t): t is { qq: number; name: string } => t !== null);
  if (selfIdNum > 0) {
    parts.push(`【机器人自己的 QQ】${selfIdNum}`);
  }
  if (atTargets.length > 0) {
    const labels = atTargets.map(({ qq, name }) => {
      const isSelf = selfIdNum > 0 && qq === selfIdNum;
      if (isSelf) return `@${qq}（机器人自己）`;
      return name ? `@${qq}（其他群友「${name}」，不是机器人）` : `@${qq}（其他群友）`;
    });
    parts.push(`【本条消息 @ 了】${labels.join("、")}`);
  }
  parts.push(`【当前消息】\n${senderLabel}: ${messageText}`);
  parts.push("请判断机器人是否应该接这条消息，只输出 JSON。");

  return { systemPrompt, userPrompt: parts.join("\n\n") };
}

/** 从模型返回里取出文本（兼容 string / {text} / {content}） */
function extractResponseText(response: any): string {
  if (typeof response === "string") return response;
  if (response && typeof response.text === "string") return response.text;
  if (response && Array.isArray(response.content)) {
    return response.content
      .map((part: any) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  if (response && typeof response.content === "string") return response.content;
  return "";
}

/** 判定器给出的接话方式：answer=认真回答/帮忙，sass=吐槽/接梗 */
export type JudgeIntent = "answer" | "sass";

/** 校验并归一化解析结果 */
function coerceJudgeResult(value: unknown): { reply: boolean; confidence?: number; reason?: string; intent?: JudgeIntent } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.reply !== "boolean") return null;

  const result: { reply: boolean; confidence?: number; reason?: string; intent?: JudgeIntent } = { reply: obj.reply };

  const rawConfidence = obj.confidence;
  if (typeof rawConfidence === "number" && Number.isFinite(rawConfidence)) {
    result.confidence = Math.max(0, Math.min(1, rawConfidence));
  } else if (typeof rawConfidence === "string" && rawConfidence.trim() !== "") {
    const n = Number(rawConfidence.trim());
    if (Number.isFinite(n)) result.confidence = Math.max(0, Math.min(1, n));
  }

  if (obj.intent === "sass") result.intent = "sass";
  else if (obj.intent === "answer") result.intent = "answer";

  if (typeof obj.reason === "string" && obj.reason.trim()) {
    result.reason = clampText(obj.reason.trim().replace(/\s+/g, " "), 120);
  }

  return result;
}

/** 稳健解析模型输出（导出便于单测）。失败返回 null。 */
export function parseJudgeJson(text: string): { reply: boolean; confidence?: number; reason?: string; intent?: JudgeIntent } | null {
  if (typeof text !== "string") return null;
  const raw = text.trim();
  if (!raw) return null;

  const candidates: string[] = [];
  // 1) markdown 代码围栏
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(raw)) !== null) {
    const inner = (match[1] ?? "").trim();
    if (inner) candidates.push(inner);
  }
  // 2) 首个 { 到最后一个 } 之间的片段（去掉前后噪声）
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(raw.slice(first, last + 1).trim());
  // 3) 原文
  candidates.push(raw);

  for (const candidate of candidates) {
    try {
      const parsed = coerceJudgeResult(JSON.parse(candidate));
      if (parsed) return parsed;
    } catch {
      /* 尝试下一个候选 */
    }
  }
  return null;
}

/** 错误信息脱敏并截断（不打印 key、不打印完整 prompt） */
function sanitizeError(error: unknown): string {
  let message: string;
  if (error instanceof Error) message = error.message || error.name || "unknown-error";
  else if (typeof error === "string") message = error;
  else message = String(error ?? "unknown-error");
  return clampText(message.replace(/\s+/g, " ").trim(), ERROR_CHARS) || "unknown-error";
}

/**
 * 调用宿主 LLM 判断是否接话。
 * 使用 api.runtime.llm.complete；不得自行读 provider key、不得 import openclaw 内部模块。
 */
export async function judgeGroupMessage(params: {
  api: any;
  smart: SmartTriggerConfig;
  groupId: number;
  selfId: number;
  senderLabel: string;
  messageText: string;
  recentMessages: Array<{ sender: string; body: string }>;
  quotedText?: string;
  /** 本条消息 @ 的目标：含机器人时由 selfId 标注；带 name 时判定器能看到对方昵称 */
  atTargets?: Array<number | { qq: number; name?: string }>;
}): Promise<{
  reply: boolean;
  source: "llm" | "fallback";
  confidence?: number;
  reason?: string;
  /** 放行时的接话方式；未放行为 undefined */
  intent?: JudgeIntent;
  model?: string;
  latencyMs: number;
  error?: string;
}> {
  const startedAt = Date.now();
  const elapsed = () => Math.max(0, Date.now() - startedAt);
  const smart = normalizeSmart(params?.smart as SmartTriggerConfig);
  const groupId = Number(params?.groupId);
  const api = params?.api;

  /** 统一 fallback：fallback=reply 时放行，否则忽略 */
  const makeFallback = (error: string) => {
    const reply = smart.fallback === "reply";
    const verdict = { reply, source: "fallback" as const, latencyMs: elapsed(), error };
    try {
      api?.logger?.warn?.(`[onebot][smart] group=${groupId} decision=fallback error="${clampText(error, 120)}"`);
    } catch {
      /* 日志失败不影响判定 */
    }
    return verdict;
  };

  const runtime = api?.runtime;
  const llm = runtime?.llm;
  if (typeof llm?.complete !== "function") {
    return makeFallback("llm-unavailable");
  }

  const aliases = Array.isArray(smart.aliases) ? smart.aliases : [];
  const { systemPrompt, userPrompt } = buildJudgePrompt({
    smart,
    senderLabel: params?.senderLabel,
    messageText: params?.messageText,
    recentMessages: Array.isArray(params?.recentMessages) ? params.recentMessages : [],
    quotedText: params?.quotedText,
    aliases,
    atTargets: Array.isArray(params?.atTargets) ? params.atTargets : [],
    selfId: Number(params?.selfId ?? 0),
  });

  let controller: any;
  let timer: any;
  let timeoutReject: ((error: Error) => void) | undefined;
  // 超时兜底：即使宿主实现忽略 signal，也用 race 保证判定不会无限挂起
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutReject = reject;
  });
  try {
    controller = new AbortController();
    const timeoutMs = Math.max(1, Math.floor(smart.timeoutMs));
    timer = setTimeout(() => {
      try {
        controller?.abort?.();
      } catch {
        /* ignore */
      }
      try {
        timeoutReject?.(new Error("judge-timeout"));
      } catch {
        /* ignore */
      }
    }, timeoutMs);
  } catch {
    controller = undefined;
    timer = undefined;
  }

  try {
    const request: Record<string, unknown> = {
      messages: [{ role: "user", content: userPrompt }],
      systemPrompt,
      purpose: "onebot.smart-trigger",
      maxTokens: 256,
      temperature: 0,
      signal: controller?.signal,
    };
    const modelName = typeof smart.model === "string" ? smart.model.trim() : "";
    if (modelName) request.model = modelName;

    const completion = Promise.resolve(llm.complete(request));
    // 超时后宿主仍可能抛错，吞掉避免 unhandledRejection
    completion.catch(() => undefined);
    const response: any = await Promise.race([completion, timeoutPromise]);
    const text = extractResponseText(response);
    const parsed = parseJudgeJson(text);
    const responseModel = typeof response?.model === "string" ? response.model : undefined;

    if (!parsed) {
      // 空响应与格式错误分开记，便于线上排查（不回显完整模型输出）
      const preview = text.trim() ? `parse-failed:${clampText(text.trim().replace(/\s+/g, " "), 80)}` : "empty-response";
      return makeFallback(preview);
    }

    const confidence = parsed.confidence;
    const reply = parsed.reply === true && (confidence ?? 1) >= smart.threshold;
    // 只在放行且开启吐槽能力时保留 sass；其余一律按 answer 处理
    const intent: JudgeIntent | undefined = !reply
      ? undefined
      : smart.sassEnabled && parsed.intent === "sass"
        ? "sass"
        : "answer";
    return {
      reply,
      source: "llm",
      confidence,
      reason: parsed.reason,
      intent,
      model: responseModel ?? (modelName || undefined),
      latencyMs: elapsed(),
    };
  } catch (error) {
    const aborted = Boolean(controller?.signal?.aborted);
    return makeFallback(aborted ? "timeout" : sanitizeError(error));
  } finally {
    if (timer !== undefined) {
      try {
        clearTimeout(timer);
      } catch {
        /* ignore */
      }
    }
  }
}
