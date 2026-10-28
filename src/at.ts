/**
 * @ 标记规范化
 *
 * 模型可能有两种写法：
 * - 推荐：[[at:2384252941]]
 * - 兼容 CQ 码：[CQ:at,qq=2384252941]（模型从历史 raw 文本里学到的写法）
 *
 * 统一规范化为 `[CQ:at,qq=2384252941]`，由 connection 的发送层转成 OneBot at 消息段。
 * 空/非法 QQ 号的 at 标记直接剥除，绝不把 `[CQ:at,qq=]` 这类字面漏到群里。
 */

const AT_MARKER_RE = /\[\[\s*at\s*:\s*([^\]]*?)\s*\]\]/gi;
const CQ_AT_RE = /\[CQ:at,qq=([^,\]]*)(?:,[^\]]*)?\]/gi;

/** 从片段中提取合法 QQ 号：5~12 位纯数字 */
function pickQq(raw: string): string | null {
  const m = String(raw ?? "").match(/\d{5,12}/);
  return m ? m[0] : null;
}

export interface NormalizedAt {
  /** 规范化后的文本（合法 at 变成 CQ 码，非法 at 被移除） */
  text: string;
  /** 本次文本里需要 @ 的 QQ 号（去重、按出现顺序） */
  atUserIds: string[];
}

/** 把 [[at:QQ]] / [CQ:at,qq=QQ] 统一成合法 CQ 码，并剔除空/非法 QQ 号。 */
export function normalizeAtMarkers(input: string): NormalizedAt {
  const atUserIds: string[] = [];
  let text = String(input ?? "");

  const push = (qq: string | null): string => {
    if (!qq) return "";
    if (!atUserIds.includes(qq)) atUserIds.push(qq);
    return `[CQ:at,qq=${qq}]`;
  };

  text = text.replace(AT_MARKER_RE, (_all, inner: string) => push(pickQq(inner)));
  text = text.replace(CQ_AT_RE, (_all, qqRaw: string) => push(pickQq(qqRaw)));

  // 清理标记留下的多余空格（不压缩换行）
  text = text.replace(/[ \t]{2,}/g, " ").trim();
  return { text, atUserIds };
}
