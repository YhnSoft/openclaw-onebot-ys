/**
 * @ 标记规范化测试
 *
 * 运行：npx tsx --test test/at.test.ts
 *
 * 线上出现过模型输出 `[CQ:at,qq=]`（空号）被当字面发到群里的问题，
 * 以及模型输出 `[CQ:at,qq=2384252941]` 需要转成真正 at 段。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeAtMarkers } from "../src/at.js";
import { textToSegments } from "../src/connection.js";

// ---------------------------------------------------------------------------
// normalizeAtMarkers
// ---------------------------------------------------------------------------

test("[[at:QQ]] 规范化为合法 CQ 码并收集 QQ 号", () => {
  const r = normalizeAtMarkers("[[at:2384252941]] 你出来");
  assert.equal(r.text, "[CQ:at,qq=2384252941] 你出来");
  assert.deepEqual(r.atUserIds, ["2384252941"]);
});

test("[CQ:at,qq=QQ] 原样保留并收集 QQ 号", () => {
  const r = normalizeAtMarkers("[CQ:at,qq=2384252941] 你好");
  assert.equal(r.text, "[CQ:at,qq=2384252941] 你好");
  assert.deepEqual(r.atUserIds, ["2384252941"]);
});

test("空 QQ 号的 at 标记被剥除（不会漏到群里）", () => {
  assert.equal(normalizeAtMarkers("[CQ:at,qq=] 你好").text, "你好");
  assert.equal(normalizeAtMarkers("[[at:]] 你好").text, "你好");
  assert.equal(normalizeAtMarkers("[[at: ]]").text, "");
  assert.deepEqual(normalizeAtMarkers("[CQ:at,qq=] 你好").atUserIds, []);
});

test("非法/过短 QQ 号被剥除", () => {
  assert.equal(normalizeAtMarkers("[[at:abc]] 你好").text, "你好");
  assert.equal(normalizeAtMarkers("[CQ:at,qq=123] 你好").text, "你好");
});

test("多个 at 去重且保持顺序", () => {
  const r = normalizeAtMarkers("[[at:1111111]] [[at:2222222]] [[at:1111111]] 好");
  assert.deepEqual(r.atUserIds, ["1111111", "2222222"]);
  assert.equal((r.text.match(/\[CQ:at,qq=1111111\]/g) ?? []).length, 2);
});

test("没有 at 时文本不变（仅去掉多余空格）", () => {
  assert.equal(normalizeAtMarkers("普通回复").text, "普通回复");
  assert.equal(normalizeAtMarkers("a  b").text, "a b");
});

// ---------------------------------------------------------------------------
// textToSegments（发送层）
// ---------------------------------------------------------------------------

test("textToSegments: CQ 码转 at 段 + 文本段", () => {
  const segs = textToSegments("[CQ:at,qq=2384252941] 你好");
  assert.deepEqual(segs, [
    { type: "at", data: { qq: "2384252941" } },
    { type: "text", data: { text: " 你好" } },
  ]);
});

test("textToSegments: 纯文本返回 null（保持字符串发送）", () => {
  assert.equal(textToSegments("普通文本"), null);
});

test("textToSegments: 多段与 CQ 反转义", () => {
  const segs = textToSegments("前[CQ:at,qq=123456]中[CQ:face,id=14]后");
  assert.deepEqual(segs, [
    { type: "text", data: { text: "前" } },
    { type: "at", data: { qq: "123456" } },
    { type: "text", data: { text: "中" } },
    { type: "face", data: { id: "14" } },
    { type: "text", data: { text: "后" } },
  ]);
});

test("textToSegments: 文本中的 &amp;/&#91; 反转义", () => {
  const segs = textToSegments("[CQ:at,qq=123456,name=a&amp;b]");
  assert.deepEqual(segs, [{ type: "at", data: { qq: "123456", name: "a&b" } }]);
});
