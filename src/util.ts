/**
 * 通用小工具
 *
 * 从各模块里重复实现的数字归一化逻辑中抽取，语义（含边界与回落值）与调用方保持一致：
 * - clampNumber：配置解析用，严格要求 number 类型，再夹到 [min, max]
 * - toNonNegativeInt：Number() 强制转换后取整，非法值回落 fallback
 *
 * 本文件只依赖标准库，不 import 任何 openclaw 内部模块。
 */

/**
 * 数值 clamp：非有限数回落 fallback，其余夹到 [min, max]。
 * @param integer 为 true 时向下取整（用于条数/毫秒等整数字段）
 */
export function clampNumber(value: unknown, fallback: number, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const v = Math.max(min, Math.min(max, value));
  return integer ? Math.floor(v) : v;
}

/**
 * 非负整数：先 Number() 强制转换（兼容字符串/布尔），再向下取整；
 * NaN / Infinity / 负数回落 fallback。
 */
export function toNonNegativeInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i >= 0 ? i : fallback;
}
