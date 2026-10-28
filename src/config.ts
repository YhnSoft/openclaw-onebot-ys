/**
 * OneBot 配置解析
 */

import type { OneBotAccountConfig } from "./types.js";
import { clampNumber } from "./util.js";

export function getOneBotConfig(api: any, accountId?: string): OneBotAccountConfig | null {
  const cfg = api?.config ?? (globalThis as any).__onebotGatewayConfig;
  const id = accountId ?? "default";

  const channel = cfg?.channels?.onebot;
  const account = channel?.accounts?.[id];
  if (account) {
    const { type, host, port, accessToken, path } = account;
    if (host && port) {
      return {
        accountId: id,
        type: type ?? "forward-websocket",
        host,
        port,
        accessToken,
        path: path ?? "/onebot/v11/ws",
        enabled: account.enabled !== false,
      };
    }
  }

  if (channel?.host && channel?.port) {
    return {
      accountId: id,
      type: channel.type ?? "forward-websocket",
      host: channel.host,
      port: channel.port,
      accessToken: channel.accessToken,
      path: channel.path ?? "/onebot/v11/ws",
    };
  }

  const type = process.env.ONEBOT_WS_TYPE as "forward-websocket" | "backward-websocket" | undefined;
  const host = process.env.ONEBOT_WS_HOST;
  const portStr = process.env.ONEBOT_WS_PORT;
  const accessToken = process.env.ONEBOT_WS_ACCESS_TOKEN;
  const path = process.env.ONEBOT_WS_PATH ?? "/onebot/v11/ws";

  if (host && portStr) {
    const port = parseInt(portStr, 10);
    if (Number.isFinite(port)) {
      return {
        accountId: id,
        type: type === "backward-websocket" ? "backward-websocket" : "forward-websocket",
        host,
        port,
        accessToken: accessToken || undefined,
        path,
      };
    }
  }

  return null;
}

/** 是否将机器人回复中的 Markdown 渲染为纯文本再发送，默认 true */
export function getRenderMarkdownToPlain(cfg: any): boolean {
  const v = cfg?.channels?.onebot?.renderMarkdownToPlain;
  return v === undefined ? true : Boolean(v);
}

function getFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 是否将连续多个换行压缩为单个换行，默认 true（AI 常输出 \n\n 导致双空行） */
export function getCollapseDoubleNewlines(cfg: any): boolean {
  const v = cfg?.channels?.onebot?.collapseDoubleNewlines;
  return v === undefined ? true : Boolean(v);
}

/** normal 模式下聚合发送的等待窗口，默认 1200ms */
export function getNormalModeFlushIntervalMs(cfg: any): number {
  const value = getFiniteNumber(cfg?.channels?.onebot?.normalModeFlushIntervalMs, 1200);
  return Math.max(200, Math.min(5000, Math.round(value)));
}

/** normal 模式下聚合发送的字符阈值，达到后提前 flush，默认 160 */
export function getNormalModeFlushChars(cfg: any): number {
  const value = getFiniteNumber(cfg?.channels?.onebot?.normalModeFlushChars, 160);
  return Math.max(20, Math.min(2000, Math.round(value)));
}

/** 白名单 QQ 号列表，为空则所有人可回复；非空则仅白名单内用户可触发 AI */
export function getWhitelistUserIds(cfg: any): number[] {
  const v = cfg?.channels?.onebot?.whitelistUserIds;
  if (!Array.isArray(v)) return [];
  return v.filter((x: unknown) => typeof x === "number" || (typeof x === "string" && /^\d+$/.test(x))).map((x) => Number(x));
}

/** 黑名单 QQ 号列表，在黑名单内的用户无法触发 AI */
export function getBlacklistUserIds(cfg: any): number[] {
  const v = cfg?.channels?.onebot?.blacklistUserIds;
  if (!Array.isArray(v)) return [];
  return v.filter((x: unknown) => typeof x === "number" || (typeof x === "string" && /^\d+$/.test(x))).map((x) => Number(x));
}

/**
 * OG 图片渲染主题：枚举 default（无额外样式）、dust（内置）、custom（使用 ogImageRenderThemePath）
 * 返回用于 getMarkdownStyles 的值：default | dust | 自定义 CSS 绝对路径
 */
export function getOgImageRenderTheme(cfg: any): "default" | "dust" | string {
  const v = cfg?.channels?.onebot?.ogImageRenderTheme;
  const path = (cfg?.channels?.onebot?.ogImageRenderThemePath ?? "").trim();
  if (v === "dust") return "dust";
  if (v === "custom" && path.length > 0) return path;
  return "default";
}

export function listAccountIds(apiOrCfg: any): string[] {
  const cfg = apiOrCfg?.config ?? apiOrCfg ?? (globalThis as any).__onebotGatewayConfig;
  const accounts = cfg?.channels?.onebot?.accounts;
  if (accounts && Object.keys(accounts).length > 0) {
    return Object.keys(accounts);
  }
  if (cfg?.channels?.onebot?.host) return ["default"];
  return [];
}

/** 
 * 触发关键词列表，当 requireMention 为 false 时生效
 * 消息包含这些关键词时触发机器人响应
 */
export function getTriggerKeywords(cfg: any): string[] {
  const v = cfg?.channels?.onebot?.triggerKeywords;
  if (!Array.isArray(v)) return [];
  return v.filter((x: unknown) => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
}

/**
 * 群聊上下文条数：触发回复时把最近 N 条群消息作为上下文一并交给模型。
 * 默认 20；设为 0 关闭历史注入（每次只看当前消息）。
 */
export function getHistoryLimit(cfg: any): number {
  const v = cfg?.channels?.onebot?.historyLimit;
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.max(0, Math.min(100, Math.floor(v)));
  }
  return 20;
}

/**
 * 是否允许模型在回复里使用 [[quote:消息ID]] 标记引用某条消息（默认开启）。
 * 关闭后不会给模型注入引用说明，也不会解析标记。
 */
export function getQuoteEnabled(cfg: any): boolean {
  const v = cfg?.channels?.onebot?.quoteEnabled;
  return v === undefined ? true : Boolean(v);
}

/**
 * 引用链追溯深度（默认 3）。
 * 消息 3 引用 2、2 引用 1 时，往上取到第 3 层，一次性拼进上下文。
 * 设为 0 时只取直接引用的那一条（不再向上追溯）。
 */
export function getQuoteChainDepth(cfg: any): number {
  const v = cfg?.channels?.onebot?.quoteChainDepth;
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.min(10, Math.floor(v)));
  return 3;
}

/**
 * 是否在「群友直接引用了机器人的发言」时立即回复（默认开启）。
 *
 * 引用机器人 = 明确在跟它说话，效果等同 @：跳过 smartTrigger 的关键词/LLM 判定直通放行。
 * 与 smartTrigger.enabled 无关，requireMention=true 时同样生效。
 */
export function getQuoteToBotReplyEnabled(cfg: any): boolean {
  const v = cfg?.channels?.onebot?.quoteToBotReply;
  return v === undefined ? true : Boolean(v);
}

/**
 * 是否在上下文里附带本地表情包库摘要（默认开启）。
 */
export function getStickerEnabled(cfg: any): boolean {
  const v = cfg?.channels?.onebot?.stickerEnabled;
  return v === undefined ? true : Boolean(v);
}

/** 上下文里展示的表情包条数，默认 8，最大 30 */
export function getStickerContextLimit(cfg: any): number {
  const v = cfg?.channels?.onebot?.stickerContextLimit;
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.min(30, Math.floor(v)));
  return 8;
}

/**
 * 关键词匹配模式
 * - "prefix": 消息以关键词开头（默认）
 * - "contains": 消息包含关键词即可
 */
export function getTriggerMode(cfg: any): "prefix" | "contains" {
  const v = cfg?.channels?.onebot?.triggerMode;
  if (v === "contains") return "contains";
  return "prefix"; // 默认为前缀匹配
}

/** 是否在用户不在白名单时回复“权限不足”，默认 true */
export function getReplyWhenWhitelistDenied(cfg: any): boolean {
  const v = cfg?.channels?.onebot?.replyWhenWhitelistDenied;
  return v === undefined ? true : Boolean(v);
}

/**
 * 智能触发（两段式）配置：keywords/aliases 直通 + LLM 判定。
 * 详见 smart-trigger-spec.md §2/§4。
 */
export interface SmartTriggerConfig {
  enabled: boolean;
  groups: number[];
  keywords: string[];
  keywordMode: "prefix" | "contains";
  aliases: string[];
  threshold: number;
  timeoutMs: number;
  minIntervalMs: number;
  cooldownMs: number;
  maxRepliesPerHour: number;
  historyLimit: number;
  maxInputChars: number;
  model: string;
  fallback: "ignore" | "reply";
  minMessageChars: number;
  allowModelSilence: boolean;
  silentMarker: string;
  /** 是否允许判定器在轻松场合选择「吐槽式接话」（intent=sass），默认 true */
  sassEnabled: boolean;
  /** 自定义吐槽风格提示；空字符串使用内置默认文案 */
  sassStyle: string;
  /** 判定器使用的人设摘要（让判定器知道「这是谁、别人怎么叫它」）；空字符串用内置默认 */
  judgePersona: string;
}

/** 字符串数组：过滤非字符串与空白项 */
function cleanSmartStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((x: unknown) => typeof x === "string")
    .map((x) => (x as string).trim())
    .filter((x) => x.length > 0);
}

/**
 * 解析 channels.onebot.smartTrigger，永不抛错，非法值回落默认值。
 * 注意：enabled 默认 false，必须显式配置为 true 才生效。
 */
export function getSmartTriggerConfig(cfg: any): SmartTriggerConfig {
  let raw: any;
  try {
    raw = cfg?.channels?.onebot?.smartTrigger;
  } catch {
    raw = undefined;
  }
  const src: any = raw && typeof raw === "object" ? raw : {};

  // groups：允许字符串数字，统一转 number
  const groups: number[] = [];
  if (Array.isArray(src.groups)) {
    for (const g of src.groups) {
      if (typeof g === "number" && Number.isFinite(g)) groups.push(g);
      else if (typeof g === "string" && /^\d+$/.test(g.trim())) groups.push(Number(g.trim()));
    }
  }

  // keywords：为空时继承 triggerKeywords
  let keywords = cleanSmartStringList(src.keywords);
  if (keywords.length === 0) {
    try {
      keywords = getTriggerKeywords(cfg);
    } catch {
      keywords = [];
    }
  }

  const keywordMode: "prefix" | "contains" = src.keywordMode === "prefix" ? "prefix" : "contains";
  const fallback: "ignore" | "reply" = src.fallback === "reply" ? "reply" : "ignore";
  const model = typeof src.model === "string" ? src.model.trim() : "";
  const silentMarkerRaw = typeof src.silentMarker === "string" ? src.silentMarker.trim() : "";

  return {
    enabled: src.enabled === true,
    groups,
    keywords,
    keywordMode,
    aliases: cleanSmartStringList(src.aliases),
    threshold: clampNumber(src.threshold, 0.6, 0, 1),
    timeoutMs: clampNumber(src.timeoutMs, 8000, 1000, 60000, true),
    minIntervalMs: clampNumber(src.minIntervalMs, 3000, 0, 600000, true),
    cooldownMs: clampNumber(src.cooldownMs, 30000, 0, 3600000, true),
    maxRepliesPerHour: clampNumber(src.maxRepliesPerHour, 6, 0, 100, true),
    historyLimit: clampNumber(src.historyLimit, 10, 0, 30, true),
    maxInputChars: clampNumber(src.maxInputChars, 2000, 200, 8000, true),
    model,
    fallback,
    minMessageChars: clampNumber(src.minMessageChars, 2, 0, 200, true),
    allowModelSilence: src.allowModelSilence === true,
    silentMarker: silentMarkerRaw.length > 0 ? silentMarkerRaw : "[[silent]]",
    sassEnabled: src.sassEnabled === undefined ? true : src.sassEnabled === true,
    sassStyle: typeof src.sassStyle === "string" ? src.sassStyle.trim() : "",
    judgePersona: typeof src.judgePersona === "string" ? src.judgePersona.trim() : "",
  };
}

/** 是否允许模型用 [[at:QQ号]] 在回复里 @ 群成员（默认开启） */
export function getAtEnabled(cfg: any): boolean {
  const v = cfg?.channels?.onebot?.atEnabled;
  return v === undefined ? true : Boolean(v);
}

/** 戳一戳回应配置（channels.onebot.pokeReply） */
export interface PokeReplyConfig {
  /** 总开关，默认 false（需显式开启） */
  enabled: boolean;
  /** 同群/同人冷却（毫秒），默认 10000，0 表示不去重 */
  cooldownMs: number;
  /** 是否先回戳一下，默认 false */
  pokeBack: boolean;
  /** 注入给模型的场景文本，默认「（戳了戳你）」 */
  prompt: string;
}

/**
 * 解析 pokeReply：被戳一戳时构造内部消息走 LLM 回复管线。
 * 默认关闭；非法值回落默认值，永不抛错。
 */
export function getPokeReplyConfig(cfg: any): PokeReplyConfig {
  let raw: any;
  try {
    raw = cfg?.channels?.onebot?.pokeReply;
  } catch {
    raw = undefined;
  }
  const src: any = raw && typeof raw === "object" ? raw : {};
  const prompt = typeof src.prompt === "string" && src.prompt.trim() ? src.prompt.trim() : "（戳了戳你）";
  return {
    enabled: src.enabled === true,
    cooldownMs: clampNumber(src.cooldownMs, 10000, 0, 600000, true),
    pokeBack: src.pokeBack === true,
    prompt,
  };
}
