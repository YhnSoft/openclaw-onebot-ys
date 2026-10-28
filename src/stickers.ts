/**
 * 表情包库：把群里见到的表情包/图片记录到本地 JSON，供模型按需发送。
 *
 * 存储位置：~/.openclaw/onebot/stickers.json
 * 结构：[{ id, url, file, note, tags, addedBy, addedAt, uses }]
 *
 * 设计原则（参考大肥鱼 sticker-lib）：
 * - 记录是显式动作，由模型/用户决定，不自动收集所有图片（避免污染与无上限增长）
 * - note/tags 是给模型看的检索线索，发送时按关键词或随机挑选
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export interface StickerEntry {
  id: string;
  /** 图片 URL 或 base64:// 或 file:// 路径 */
  url?: string;
  /** 本地文件路径（可选） */
  file?: string;
  /** 备注：这个表情包表示什么情绪/含义 */
  note?: string;
  tags: string[];
  addedBy?: string;
  addedAt: number;
  uses: number;
}

const STORE_DIR = path.join(os.homedir(), ".openclaw", "onebot");
const STORE_PATH = path.join(STORE_DIR, "stickers.json");
export const STICKER_STORE_PATH = STORE_PATH;

/**
 * 错误日志：优先走插件 logger（由 index.ts 注册到 globalThis.__onebotApi），
 * 未注入 logger 时回落 console.error，保证 CLI / 单测场景仍然可见。
 */
function logError(message: string): void {
  try {
    const logger = (globalThis as any).__onebotApi?.logger;
    if (typeof logger?.error === "function") {
      logger.error(message);
      return;
    }
  } catch {
    /* logger 不可用时走下面的 console */
  }
  console.error(message);
}

let cache: StickerEntry[] | null = null;

function normalizeEntry(raw: any): StickerEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const url = String(raw.url ?? "").trim();
  const file = String(raw.file ?? "").trim();
  if (!url && !file) return null;
  const id = String(raw.id ?? "").trim() || hashId(url || file);
  return {
    id,
    url: url || undefined,
    file: file || undefined,
    note: raw.note ? String(raw.note).slice(0, 200) : undefined,
    tags: Array.isArray(raw.tags)
      ? raw.tags.map((t: unknown) => String(t).trim()).filter(Boolean).slice(0, 20)
      : [],
    addedBy: raw.addedBy ? String(raw.addedBy) : undefined,
    addedAt: Number(raw.addedAt) || Date.now(),
    uses: Number(raw.uses) || 0,
  };
}

function hashId(value: string): string {
  return crypto.createHash("md5").update(value).digest("hex").slice(0, 10);
}

export function loadStickers(): StickerEntry[] {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const arr = JSON.parse(raw);
    cache = Array.isArray(arr)
      ? arr.map(normalizeEntry).filter((x): x is StickerEntry => x != null)
      : [];
  } catch {
    cache = [];
  }
  return cache;
}

function persist(list: StickerEntry[]): void {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, `${JSON.stringify(list, null, 2)}\n`, "utf8");
  } catch (e: any) {
    logError(`[onebot] 保存表情包库失败: ${e?.message ?? e}`);
  }
}

export interface AddStickerInput {
  url?: string;
  file?: string;
  note?: string;
  tags?: string[];
  addedBy?: string;
}

const STICKER_FILE_DIR = path.join(STORE_DIR, "stickers");

/** 把远程图片落盘，避免 QQ 临时链接过期后无法发送 */
async function materializeSticker(url: string, id: string): Promise<string | undefined> {
  try {
    if (!/^https?:\/\//i.test(url)) return undefined;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return undefined;
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    const ext = type.includes("gif")
      ? ".gif"
      : type.includes("webp")
        ? ".webp"
        : type.includes("png")
          ? ".png"
          : ".jpg";
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 8 * 1024 * 1024) return undefined;
    fs.mkdirSync(STICKER_FILE_DIR, { recursive: true });
    const filePath = path.join(STICKER_FILE_DIR, `${id}${ext}`);
    fs.writeFileSync(filePath, buf);
    return filePath;
  } catch {
    return undefined;
  }
}

export async function addSticker(input: AddStickerInput): Promise<StickerEntry> {
  const list = loadStickers();
  const url = input.url?.trim();
  const file = input.file?.trim();
  if (!url && !file) throw new Error("表情包需要一个 url 或 file");
  const id = hashId(url || file!);
  // 同一来源去重：已存在则更新 note/tags
  const exist = list.find(
    (s) => (url && s.url === url) || (file && s.file === file) || s.id === id
  );
  if (exist) {
    if (input.note) exist.note = input.note.slice(0, 200);
    if (input.tags?.length) exist.tags = [...new Set([...exist.tags, ...input.tags])].slice(0, 20);
    if (input.addedBy) exist.addedBy = input.addedBy;
    persist(list);
    return exist;
  }
  const localFile = file || (url ? await materializeSticker(url, id) : undefined);
  const entry: StickerEntry = {
    id,
    url: url || undefined,
    file: localFile || undefined,
    note: input.note?.slice(0, 200),
    tags: (input.tags ?? []).slice(0, 20),
    addedBy: input.addedBy,
    addedAt: Date.now(),
    uses: 0,
  };
  list.push(entry);
  // 上限保护，避免无限增长
  if (list.length > 300) list.splice(0, list.length - 300);
  persist(list);
  return entry;
}

/** 按 id / note / tags / url 关键字查找 */
export function findStickers(keyword?: string): StickerEntry[] {
  const list = loadStickers();
  const k = keyword?.trim().toLowerCase();
  if (!k) return list;
  return list.filter(
    (s) =>
      s.id.toLowerCase().includes(k) ||
      (s.note ?? "").toLowerCase().includes(k) ||
      s.tags.some((t) => t.toLowerCase().includes(k)) ||
      (s.url ?? "").toLowerCase().includes(k)
  );
}

/** 挑一张：优先关键词匹配，否则随机；返回后会累加 uses */
export function pickSticker(keyword?: string): StickerEntry | undefined {
  const list = loadStickers();
  if (list.length === 0) return undefined;
  const matched = findStickers(keyword);
  const pool = matched.length > 0 ? matched : list;
  const entry = pool[Math.floor(Math.random() * pool.length)];
  entry.uses += 1;
  persist(list);
  return entry;
}

/** 给模型的可用表情包摘要（控制长度，避免占太多 token） */
export function buildStickerContext(limit = 8): string {
  const list = loadStickers();
  if (list.length === 0) return "";
  const recent = [...list].sort((a, b) => b.addedAt - a.addedAt).slice(0, Math.max(1, limit));
  const lines = recent.map((s) => {
    const desc = s.note || (s.tags.length ? s.tags.join("/") : "未备注");
    return `- ${s.id}：${desc}`;
  });
  return lines.join("\n");
}
