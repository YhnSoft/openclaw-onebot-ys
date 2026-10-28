/**
 * 引用链（src/quote-chain.ts）单元测试
 *
 * 运行：npx tsx --test test/quote-chain.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildQuoteChain, formatQuoteChain, quoteChainToText, quoteTargetIsSelf } from "../src/quote-chain.js";
import { getQuoteChainDepth, getQuoteToBotReplyEnabled } from "../src/config.js";

/**
 * 造一条消息：quotedId 存在时带 reply 段（表示它引用了 quotedId）；
 * senderId 存在时带 sender.user_id（用于引用机器人判定）。
 */
function makeMsg(id: number, who: string, text: string, quotedId?: number, senderId?: number) {
  const message: any[] = [];
  if (quotedId != null) message.push({ type: "reply", data: { id: String(quotedId) } });
  message.push({ type: "text", data: { text } });
  return {
    message_id: id,
    sender: senderId != null ? { nickname: who, user_id: senderId } : { nickname: who },
    message,
    message_type: "group",
  };
}

function fetcherOf(msgs: ReturnType<typeof makeMsg>[]) {
  const map = new Map(msgs.map((m) => [m.message_id, m]));
  return async (id: number) => map.get(id) ?? null;
}

test("引用链: 3→2→1 一次性取回，返回由旧到新", async () => {
  const chain = await buildQuoteChain({
    firstMessageId: 2, // 当前消息引用的是 2
    fetchMessage: fetcherOf([
      makeMsg(1, "李四", "又蓝屏了"),
      makeMsg(2, "阿三", "换台机器吧", 1),
      makeMsg(3, "王五", "换了也蓝", 2),
    ]),
    maxDepth: 3,
  });
  assert.deepEqual(
    chain.map((e) => [e.id, e.sender, e.text]),
    [
      [1, "李四", "又蓝屏了"],
      [2, "阿三", "换台机器吧"],
    ],
  );
});

test("引用链: 单层时 formatQuoteChain 保持原格式（含消息 ID）", async () => {
  const chain = await buildQuoteChain({
    firstMessageId: 2,
    fetchMessage: fetcherOf([makeMsg(2, "阿三", "换台机器吧")]),
  });
  assert.equal(chain.length, 1);
  assert.equal(formatQuoteChain(chain), "[引用 阿三 的消息（#2）：换台机器吧]");
});

test("引用链: 多层 formatQuoteChain 带序号与消息 ID（由旧到新）", async () => {
  const chain = await buildQuoteChain({
    firstMessageId: 2,
    fetchMessage: fetcherOf([makeMsg(1, "李四", "A"), makeMsg(2, "阿三", "B", 1)]),
  });
  const block = formatQuoteChain(chain);
  assert.ok(block.includes("[引用链（由旧到新，共 2 条）]"));
  assert.ok(block.includes("1. [#1] 李四：A"));
  assert.ok(block.includes("2. [#2] 阿三：B"));
  assert.ok(block.indexOf("1. [#1] 李四") < block.indexOf("2. [#2] 阿三"));
});

test("引用链: maxDepth 限制追溯层数", async () => {
  const msgs = [
    makeMsg(1, "A", "1"),
    makeMsg(2, "B", "2", 1),
    makeMsg(3, "C", "3", 2),
  ];
  const one = await buildQuoteChain({ firstMessageId: 3, fetchMessage: fetcherOf(msgs), maxDepth: 1 });
  assert.deepEqual(one.map((e) => e.id), [3]);

  const two = await buildQuoteChain({ firstMessageId: 3, fetchMessage: fetcherOf(msgs), maxDepth: 2 });
  assert.deepEqual(two.map((e) => e.id), [2, 3]);
});

test("引用链: 成环不会死循环", async () => {
  const chain = await buildQuoteChain({
    firstMessageId: 2,
    fetchMessage: fetcherOf([makeMsg(2, "B", "2", 3), makeMsg(3, "C", "3", 2)]),
    maxDepth: 10,
  });
  assert.ok(chain.length <= 2);
  assert.deepEqual(chain.map((e) => e.id), [3, 2]);
});

test("引用链: 支持负数消息 ID（QQ NT 的 msgId 可能为负）", async () => {
  const negId = -293841772;
  const chain = await buildQuoteChain({
    firstMessageId: negId,
    fetchMessage: async (id) => (id === negId ? makeMsg(negId, "A", "负数 ID") : null),
  });
  assert.equal(chain.length, 1);
  assert.equal(chain[0]!.id, negId);
  assert.ok(formatQuoteChain(chain).includes(`#${negId}`));
});

test("引用链: 起始 ID 为 0 / 非数字时返回空数组", async () => {
  assert.deepEqual(await buildQuoteChain({ firstMessageId: 0, fetchMessage: async () => null }), []);
  assert.deepEqual(await buildQuoteChain({ firstMessageId: NaN, fetchMessage: async () => null }), []);
});

test("引用链: 取不到消息时返回空数组", async () => {
  const chain = await buildQuoteChain({ firstMessageId: 999, fetchMessage: fetcherOf([]) });
  assert.deepEqual(chain, []);
});

test("引用链: fetch 抛错时安全中断", async () => {
  const chain = await buildQuoteChain({
    firstMessageId: 2,
    fetchMessage: async () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(chain, []);
});

test("引用链: 非文本消息用占位符", async () => {
  const chain = await buildQuoteChain({
    firstMessageId: 5,
    fetchMessage: async () => ({ message_id: 5, sender: { nickname: "D" }, message: [] }),
  });
  assert.equal(chain[0]!.text, "[非文本消息]");
});

test("引用链: 总量上限从最新往前保留", async () => {
  const chain = await buildQuoteChain({
    firstMessageId: 2,
    fetchMessage: fetcherOf([
      makeMsg(1, "A", "x".repeat(300)),
      makeMsg(2, "B", "y".repeat(300), 1),
    ]),
    maxDepth: 3,
    maxTotalChars: 350,
  });
  // 只保留更接近当前的那条
  assert.deepEqual(chain.map((e) => e.id), [2]);
});

test("引用链: quoteChainToText 拼成纯文本", async () => {
  const chain = await buildQuoteChain({
    firstMessageId: 2,
    fetchMessage: fetcherOf([makeMsg(1, "李四", "A"), makeMsg(2, "阿三", "B", 1)]),
  });
  assert.equal(quoteChainToText(chain), "李四：A\n阿三：B");
});

test("getQuoteChainDepth: 默认 3，支持 0 关闭与上限 clamp", () => {
  assert.equal(getQuoteChainDepth({}), 3);
  assert.equal(getQuoteChainDepth({ channels: { onebot: { quoteChainDepth: 0 } } }), 0);
  assert.equal(getQuoteChainDepth({ channels: { onebot: { quoteChainDepth: 5 } } }), 5);
  assert.equal(getQuoteChainDepth({ channels: { onebot: { quoteChainDepth: 99 } } }), 10);
  assert.equal(getQuoteChainDepth({ channels: { onebot: { quoteChainDepth: -3 } } }), 0);
});

// ---------------------------------------------------------------------------
// senderId / quoteTargetIsSelf / getQuoteToBotReplyEnabled（引用机器人立即回复）
// ---------------------------------------------------------------------------

const SELF_ID = 99999;
const FRIEND_ID = 10001;

test("引用链: entry 带 senderId（来自 get_msg 的 sender.user_id）", async () => {
  const chain = await buildQuoteChain({
    firstMessageId: 2,
    fetchMessage: fetcherOf([
      makeMsg(1, "张三", "原文", undefined, FRIEND_ID),
      makeMsg(2, "机器人", "我答的", 1, SELF_ID),
    ]),
  });
  assert.equal(chain.length, 2);
  assert.equal(chain[0]!.senderId, FRIEND_ID);
  assert.equal(chain[1]!.senderId, SELF_ID);

  // 拿不到 user_id 时不带该字段（避免用昵称猜测）
  const noId = await buildQuoteChain({
    firstMessageId: 3,
    fetchMessage: fetcherOf([makeMsg(3, "某人", "x")]),
  });
  assert.equal("senderId" in noId[0]!, false);
});

test("quoteTargetIsSelf: 直接引用机器人 → true", () => {
  // 单层：链尾就是被直接引用的机器人消息
  assert.equal(quoteTargetIsSelf([{ id: 500, sender: "机器人", senderId: SELF_ID, text: "我答的" }], SELF_ID), true);
  // 多层：只看链尾（当前消息直接引用的那条）
  assert.equal(
    quoteTargetIsSelf(
      [
        { id: 400, sender: "张三", senderId: FRIEND_ID, text: "原文" },
        { id: 500, sender: "机器人", senderId: SELF_ID, text: "我答的" },
      ],
      SELF_ID,
    ),
    true,
  );
});

test("quoteTargetIsSelf: 直接引用群友、更早节点才是机器人 → false", () => {
  assert.equal(
    quoteTargetIsSelf(
      [
        { id: 500, sender: "机器人", senderId: SELF_ID, text: "我答的" },
        { id: 600, sender: "张三", senderId: FRIEND_ID, text: "我说一句" },
      ],
      SELF_ID,
    ),
    false,
  );
});

test("quoteTargetIsSelf: 空链 / 非法 selfId → false", () => {
  const botChain = [{ id: 500, sender: "机器人", senderId: SELF_ID, text: "x" }];
  assert.equal(quoteTargetIsSelf([], SELF_ID), false);
  assert.equal(quoteTargetIsSelf(undefined as any, SELF_ID), false);
  assert.equal(quoteTargetIsSelf(null as any, SELF_ID), false);
  assert.equal(quoteTargetIsSelf(botChain, 0), false);
  assert.equal(quoteTargetIsSelf(botChain, undefined as any), false);
  assert.equal(quoteTargetIsSelf(botChain, Number.NaN), false);
  assert.equal(quoteTargetIsSelf(botChain, -1), false);
  // 链尾是群友
  assert.equal(quoteTargetIsSelf(botChain, FRIEND_ID), false);
});

test("quoteTargetIsSelf: 链尾缺 senderId → false（不靠昵称猜）", () => {
  assert.equal(quoteTargetIsSelf([{ id: 500, sender: "机器人", text: "x" }], SELF_ID), false);
});

test("quoteTargetIsSelf: 负数 message_id 场景照常判定", async () => {
  const negBotId = -293841772;
  const chain = await buildQuoteChain({
    firstMessageId: negBotId,
    fetchMessage: async (id) => (id === negBotId ? makeMsg(negBotId, "机器人", "负数 ID", undefined, SELF_ID) : null),
  });
  assert.equal(chain.length, 1);
  assert.equal(chain[0]!.id, negBotId);
  assert.equal(quoteTargetIsSelf(chain, SELF_ID), true);
  assert.equal(quoteTargetIsSelf(chain, FRIEND_ID), false);

  // 负数 ID 的链尾若是群友，同样不直通
  const negFriendChain = await buildQuoteChain({
    firstMessageId: -500,
    fetchMessage: async (id) => (id === -500 ? makeMsg(-500, "张三", "负数组友", undefined, FRIEND_ID) : null),
  });
  assert.equal(quoteTargetIsSelf(negFriendChain, SELF_ID), false);
});

test("getQuoteToBotReplyEnabled: 默认开启，显式 false 才关闭", () => {
  assert.equal(getQuoteToBotReplyEnabled({}), true);
  assert.equal(getQuoteToBotReplyEnabled(null), true);
  assert.equal(getQuoteToBotReplyEnabled({ channels: { onebot: {} } }), true);
  assert.equal(getQuoteToBotReplyEnabled({ channels: { onebot: { quoteToBotReply: false } } }), false);
  assert.equal(getQuoteToBotReplyEnabled({ channels: { onebot: { quoteToBotReply: true } } }), true);
});
