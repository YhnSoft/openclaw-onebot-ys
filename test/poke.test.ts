/**
 * 戳一戳（poke / 拍一拍）事件测试
 *
 * 运行：npx tsx --test test/poke.test.ts
 *
 * 覆盖：事件形态识别、目标判定、配置开关、冷却、回戳、以及「构造内部消息走 LLM 回复管线」。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { getPokeReplyConfig } from "../src/config.js";
import { handlePoke, isPokeToSelf, resetPokeState, type PokeDeps } from "../src/handlers/poke.js";
import type { OneBotMessage } from "../src/types.js";

const SELF_ID = 99999;
const USER_ID = 10001;
const GROUP_ID = 123456;

function pokeEvent(overrides: Record<string, unknown> = {}): OneBotMessage {
  return {
    post_type: "notice",
    notice_type: "notify",
    sub_type: "poke",
    group_id: GROUP_ID,
    user_id: USER_ID,
    target_id: SELF_ID,
    self_id: SELF_ID,
    ...overrides,
  } as OneBotMessage;
}

function makeApi(overrides: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const api: any = {
    config: {
      channels: {
        onebot: {
          host: "127.0.0.1",
          port: 3001,
          pokeReply: { enabled: true, cooldownMs: 10000, pokeBack: false, ...overrides },
        },
      },
    },
    logger: {
      info: (m: unknown) => logs.push(`info: ${String(m)}`),
      warn: (m: unknown) => logs.push(`warn: ${String(m)}`),
      error: (m: unknown) => logs.push(`error: ${String(m)}`),
    },
  };
  return { api, logs };
}

function makeDeps() {
  const calls: { process: Array<{ msg: OneBotMessage }>; groupPoke: Array<[number, number]>; friendPoke: Array<number> } = {
    process: [],
    groupPoke: [],
    friendPoke: [],
  };
  const deps: PokeDeps = {
    processInboundMessage: async (_api, msg) => {
      calls.process.push({ msg });
    },
    sendGroupPoke: async (groupId, userId) => {
      calls.groupPoke.push([groupId, userId]);
    },
    sendFriendPoke: async (userId) => {
      calls.friendPoke.push(userId);
    },
  };
  return { deps, calls };
}

// ---------------------------------------------------------------------------
// 事件识别
// ---------------------------------------------------------------------------

test("isPokeToSelf: notify+poke 且 target 是机器人 → true", () => {
  assert.equal(isPokeToSelf(pokeEvent()), true);
});

test("isPokeToSelf: notice_type=poke 形态（Lagrange）→ true", () => {
  assert.equal(isPokeToSelf(pokeEvent({ notice_type: "poke", sub_type: undefined })), true);
});

test("isPokeToSelf: 戳的是别人 → false", () => {
  assert.equal(isPokeToSelf(pokeEvent({ target_id: 20002 })), false);
});

test("isPokeToSelf: 普通消息 / group_increase → false", () => {
  assert.equal(isPokeToSelf({ post_type: "message", message_type: "group" } as any), false);
  assert.equal(
    isPokeToSelf({ post_type: "notice", notice_type: "group_increase", self_id: SELF_ID, user_id: USER_ID } as any),
    false,
  );
});

// ---------------------------------------------------------------------------
// 配置解析
// ---------------------------------------------------------------------------

test("getPokeReplyConfig: 默认关闭、冷却 10s、不回戳、默认场景文本", () => {
  const cfg = getPokeReplyConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.cooldownMs, 10000);
  assert.equal(cfg.pokeBack, false);
  assert.equal(cfg.prompt, "（戳了戳你）");
});

test("getPokeReplyConfig: 非法值回落、冷却 clamp、自定义 prompt", () => {
  const cfg = getPokeReplyConfig({
    channels: { onebot: { pokeReply: { enabled: "yes", cooldownMs: -5, pokeBack: 1, prompt: "  （拍一拍你）  " } } },
  });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.cooldownMs, 0);
  assert.equal(cfg.pokeBack, false);
  assert.equal(cfg.prompt, "（拍一拍你）");
});

// ---------------------------------------------------------------------------
// 处理链路
// ---------------------------------------------------------------------------

test("handlePoke: 未开启时不回应", async () => {
  resetPokeState();
  const { api } = makeApi({ enabled: false });
  const { deps, calls } = makeDeps();
  await handlePoke(api, pokeEvent(), deps);
  assert.equal(calls.process.length, 0);
});

test("handlePoke: 戳的不是机器人时不回应", async () => {
  resetPokeState();
  const { api } = makeApi();
  const { deps, calls } = makeDeps();
  await handlePoke(api, pokeEvent({ target_id: 20002 }), deps);
  assert.equal(calls.process.length, 0);
});

test("handlePoke: 被戳时构造内部消息走 LLM 回复管线（forceDispatch）", async () => {
  resetPokeState();
  const { api } = makeApi();
  const { deps, calls } = makeDeps();

  await handlePoke(api, pokeEvent(), deps);

  assert.equal(calls.process.length, 1);
  const msg = calls.process[0].msg;
  assert.equal(msg.__onebotForceDispatch, true);
  assert.equal(msg.message_type, "group");
  assert.equal(msg.group_id, GROUP_ID);
  assert.equal(msg.user_id, USER_ID);
  assert.equal(msg.self_id, SELF_ID);
  assert.equal(msg.message_id, undefined, "不应带 message_id，避免对合成消息做表情回应");
  assert.equal(msg.raw_message, "（戳了戳你）");
});

test("handlePoke: 自定义 prompt 注入", async () => {
  resetPokeState();
  const { api } = makeApi({ prompt: "（戳了戳你的脑袋）" });
  const { deps, calls } = makeDeps();
  await handlePoke(api, pokeEvent(), deps);
  assert.equal(calls.process[0].msg.raw_message, "（戳了戳你的脑袋）");
});

test("handlePoke: 同群同人冷却内只回应一次，reset 后恢复", async () => {
  resetPokeState();
  const { api, logs } = makeApi({ cooldownMs: 10000 });
  const { deps, calls } = makeDeps();

  await handlePoke(api, pokeEvent(), deps);
  await handlePoke(api, pokeEvent(), deps);
  assert.equal(calls.process.length, 1);
  assert.ok(logs.some((l) => l.includes("skip reason=cooldown")), logs.join("\n"));

  resetPokeState();
  await handlePoke(api, pokeEvent(), deps);
  assert.equal(calls.process.length, 2);
});

test("handlePoke: cooldownMs=0 时不去重", async () => {
  resetPokeState();
  const { api } = makeApi({ cooldownMs: 0 });
  const { deps, calls } = makeDeps();
  await handlePoke(api, pokeEvent(), deps);
  await handlePoke(api, pokeEvent(), deps);
  assert.equal(calls.process.length, 2);
});

test("handlePoke: pokeBack=true 时先回戳（群聊 group_poke）", async () => {
  resetPokeState();
  const { api } = makeApi({ pokeBack: true });
  const { deps, calls } = makeDeps();
  await handlePoke(api, pokeEvent(), deps);
  assert.deepEqual(calls.groupPoke, [[GROUP_ID, USER_ID]]);
  assert.equal(calls.process.length, 1);
});

test("handlePoke: 私聊 pokeBack 走 friend_poke", async () => {
  resetPokeState();
  const { api } = makeApi({ pokeBack: true });
  const { deps, calls } = makeDeps();
  await handlePoke(api, pokeEvent({ group_id: undefined }), deps);
  assert.deepEqual(calls.friendPoke, [USER_ID]);
  assert.equal(calls.process[0].msg.message_type, "private");
});

test("handlePoke: 回戳失败不影响 LLM 回应", async () => {
  resetPokeState();
  const { api, logs } = makeApi({ pokeBack: true });
  const { deps, calls } = makeDeps();
  deps.sendGroupPoke = async () => {
    throw new Error("retcode=100");
  };
  await handlePoke(api, pokeEvent(), deps);
  assert.equal(calls.process.length, 1);
  assert.ok(logs.some((l) => l.includes("poke back failed")), logs.join("\n"));
});
