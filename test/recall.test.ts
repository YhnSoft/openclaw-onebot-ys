/**
 * 撤回功能的「最近发送消息」记录（src/recall.ts）单元测试
 *
 * 运行：npx tsx --test test/recall.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  noteSentMessage,
  getLastSentMessage,
  clearLastSentMessage,
  normalizeRecallTarget,
  resetRecallState,
} from "../src/recall.js";

test("recall: 记录并取回最近一条消息 ID，后写的覆盖先写的", () => {
  resetRecallState();
  assert.equal(getLastSentMessage("group:1"), undefined);
  noteSentMessage("group:1", 100);
  assert.equal(getLastSentMessage("group:1"), 100);
  noteSentMessage("onebot:group:1", "200");
  assert.equal(getLastSentMessage("group:1"), 200);
});

test("recall: 非法 messageId 被忽略（undefined/非数字/0）", () => {
  resetRecallState();
  noteSentMessage("group:2", undefined);
  noteSentMessage("group:2", "abc");
  noteSentMessage("group:2", 0);
  assert.equal(getLastSentMessage("group:2"), undefined);
});

test("recall: 允许负数 ID（部分 OneBot 实现的 message_id 为负）", () => {
  resetRecallState();
  noteSentMessage("group:3", -5);
  assert.equal(getLastSentMessage("group:3"), -5);
});

test("recall: 不同会话互不干扰", () => {
  resetRecallState();
  noteSentMessage("group:4", 401);
  noteSentMessage("user:4", 402);
  assert.equal(getLastSentMessage("group:4"), 401);
  assert.equal(getLastSentMessage("user:4"), 402);
});

test("recall: 撤回后清理记录，ID 不匹配时保留", () => {
  resetRecallState();
  noteSentMessage("user:1", 300);
  clearLastSentMessage("user:1", 300);
  assert.equal(getLastSentMessage("user:1"), undefined);

  noteSentMessage("user:1", 301);
  clearLastSentMessage("user:1", 999);
  assert.equal(getLastSentMessage("user:1"), 301);
});

test("recall: target 归一化（trim + 去掉 onebot: 前缀）", () => {
  assert.equal(normalizeRecallTarget("  onebot:group:42  "), "group:42");
  assert.equal(normalizeRecallTarget("group:42"), "group:42");
  assert.equal(normalizeRecallTarget(""), "");
});
