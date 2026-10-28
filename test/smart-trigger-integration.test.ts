/**
 * 智能触发（smart trigger）集成测试 —— 对应 smart-trigger-spec.md §9 / §6
 *
 * 运行：npx tsx --test test/smart-trigger-integration.test.ts
 *
 * 直接调用 processInboundMessage + mock api，验证 §6 接入契约：
 * @ 必回、关键词直通、LLM 放行/忽略、fallback、cooldown、in-flight 并发保护、
 * allowModelSilence、deliver 静默。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { processInboundMessage } from "../src/handlers/process-inbound.js";
import { resetSmartTriggerState } from "../src/smart-trigger.js";

const GROUP_ID = 123456;
const SELF_ID = 99999;
const USER_ID = 10001;

interface ApiState {
  /** dispatchReplyWithBufferedBlockDispatcher 被调用次数（= 是否放行到正常回复流程） */
  dispatchCount: number;
  /** api.runtime.llm.complete 被调用次数 */
  llmCount: number;
  llmRequests: any[];
  /** 每次 dispatch 收到的 ctx.Body */
  bodies: string[];
  /** 所有日志（level: msg） */
  logs: string[];
  /** dispatcherOptions.deliver 被调用次数 */
  deliverCount: number;
}

interface ApiOptions {
  smart?: Record<string, unknown>;
  /** 自定义 llm.complete 实现 */
  complete?: (req: any, state: ApiState) => any;
  /** 若设置，则 dispatch mock 内部会用该文本调用一次 deliver */
  deliverText?: string;
}

function createApi(options: ApiOptions = {}): { api: any; state: ApiState } {
  const state: ApiState = {
    dispatchCount: 0,
    llmCount: 0,
    llmRequests: [],
    bodies: [],
    logs: [],
    deliverCount: 0,
  };
  const record = (level: string) => (msg: unknown) => {
    state.logs.push(`${level}: ${String(msg)}`);
  };

  const api: any = {
    config: {
      channels: {
        onebot: {
          host: "127.0.0.1",
          port: 3001,
          smartTrigger: { enabled: true, ...(options.smart ?? {}) },
        },
      },
    },
    logger: { info: record("info"), warn: record("warn"), error: record("error") },
    runtime: {
      llm: {
        complete: async (req: any) => {
          state.llmCount += 1;
          state.llmRequests.push(req);
          if (options.complete) return await options.complete(req, state);
          return { text: '{"reply":true,"confidence":0.9,"reason":"提问"}' };
        },
      },
      channel: {
        routing: { resolveAgentRoute: () => ({ agentId: "main" }) },
        session: { resolveStorePath: () => "/tmp/x", recordInboundSession: async () => {} },
        activity: { record: () => {} },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (args: any) => {
            state.dispatchCount += 1;
            state.bodies.push(String(args?.ctx?.Body ?? ""));
            if (options.deliverText !== undefined) {
              state.deliverCount += 1;
              const deliver = args?.dispatcherOptions?.deliver;
              if (typeof deliver === "function") {
                await deliver({ text: options.deliverText }, { kind: "final" });
              }
            }
          },
        },
      },
    },
  };

  return { api, state };
}

function atSegment(qq: number = SELF_ID) {
  return { type: "at", data: { qq: String(qq) } };
}

function groupMessage(text: string, extraSegments: any[] = [], overrides: Record<string, unknown> = {}) {
  return {
    post_type: "message",
    message_type: "group",
    group_id: GROUP_ID,
    user_id: USER_ID,
    self_id: SELF_ID,
    message_id: 1,
    message: [{ type: "text", data: { text } }, ...extraSegments],
    sender: { nickname: "张三" },
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
// 第一段：@ 必回 / 关键词直通
// ---------------------------------------------------------------------------

test("@ 必回：含 at(qq=self) 的群消息直接 dispatch，不调用 LLM", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({ smart: { keywords: ["机器人"] } });

  await processInboundMessage(api, groupMessage(" 你好", [atSegment()]));

  assert.equal(state.dispatchCount, 1);
  assert.equal(state.llmCount, 0);
});

test("关键词直通：命中 keywords → dispatch 且 llm.complete 调用次数为 0", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({ smart: { keywords: ["机器人"] } });

  await processInboundMessage(api, groupMessage("机器人帮我看看这个报错"));

  assert.equal(state.dispatchCount, 1);
  assert.equal(state.llmCount, 0);
  assert.ok(
    state.logs.some((l) => l.includes("[onebot][smart]") && l.includes("decision=reply source=keyword")),
    state.logs.join("\n"),
  );
});

test("关键词模式为 prefix 时：非开头命中不直通，走 LLM 判定", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({ smart: { keywords: ["机器人"], keywordMode: "prefix" } });

  await processInboundMessage(api, groupMessage("请问机器人能帮我看看吗"));

  assert.equal(state.llmCount, 1);
  assert.equal(state.dispatchCount, 1);
});

// ---------------------------------------------------------------------------
// 第二段：LLM 判定
// ---------------------------------------------------------------------------

test("未命中关键词 + LLM reply=true → dispatch", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi();

  await processInboundMessage(api, groupMessage("今天天气不错"));

  assert.equal(state.llmCount, 1);
  assert.equal(state.dispatchCount, 1);
  assert.ok(
    state.logs.some((l) => l.includes("decision=reply source=llm")),
    state.logs.join("\n"),
  );
  // 判定请求确实带上了当前消息
  assert.ok(state.llmRequests[0].messages[0].content.includes("今天天气不错"));
});

test("未命中关键词 + LLM reply=false → 不 dispatch", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({
    complete: () => ({ text: '{"reply":false,"confidence":0.2,"reason":"闲聊"}' }),
  });

  await processInboundMessage(api, groupMessage("今天吃什么好呢"));

  assert.equal(state.llmCount, 1);
  assert.equal(state.dispatchCount, 0);
  assert.ok(
    state.logs.some((l) => l.includes("decision=ignore source=llm")),
    state.logs.join("\n"),
  );
});

test("LLM 抛错 + fallback=ignore → 不 dispatch", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({
    smart: { fallback: "ignore" },
    complete: () => {
      throw new Error("llm down");
    },
  });

  await processInboundMessage(api, groupMessage("这个配置怎么写"));

  assert.equal(state.llmCount, 1);
  assert.equal(state.dispatchCount, 0);
  assert.ok(
    state.logs.some((l) => l.includes("decision=fallback")),
    state.logs.join("\n"),
  );
});

test("LLM 抛错 + fallback=reply → dispatch", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({
    smart: { fallback: "reply" },
    complete: () => {
      throw new Error("llm down");
    },
  });

  await processInboundMessage(api, groupMessage("这个配置怎么写"));

  assert.equal(state.llmCount, 1);
  assert.equal(state.dispatchCount, 1);
});

// ---------------------------------------------------------------------------
// 成本护栏：cooldown
// ---------------------------------------------------------------------------

test("cooldown 生效：第一次放行后，第二条未命中消息不再调用 LLM", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({ smart: { minIntervalMs: 0, cooldownMs: 30000 } });

  await processInboundMessage(api, groupMessage("这条值得接话吗啊", [], { message_id: 1 }));
  assert.equal(state.llmCount, 1);
  assert.equal(state.dispatchCount, 1);

  await processInboundMessage(api, groupMessage("再补一句看看情况", [], { message_id: 2 }));
  assert.equal(state.llmCount, 1, "cooldown 内不应再调用 LLM");
  assert.equal(state.dispatchCount, 1, "cooldown 内不应再放行");
  assert.ok(
    state.logs.some((l) => l.includes("decision=skip reason=cooldown")),
    state.logs.join("\n"),
  );
});

test("min-interval 生效：判定后立刻再来一条消息不重复调用 LLM", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({
    smart: { minIntervalMs: 60000, cooldownMs: 0 },
    complete: () => ({ text: '{"reply":false,"confidence":0.1,"reason":"闲聊"}' }),
  });

  await processInboundMessage(api, groupMessage("第一条普通消息", [], { message_id: 1 }));
  assert.equal(state.llmCount, 1);
  assert.equal(state.dispatchCount, 0);

  await processInboundMessage(api, groupMessage("第二条普通消息", [], { message_id: 2 }));
  assert.equal(state.llmCount, 1, "min-interval 内不应再调用 LLM");
  assert.ok(
    state.logs.some((l) => l.includes("decision=skip reason=min-interval")),
    state.logs.join("\n"),
  );
});

// ---------------------------------------------------------------------------
// in-flight：同群并发只判定一次
// ---------------------------------------------------------------------------

test("同群并发两条未命中消息：in-flight 保证只调用一次 LLM", async () => {
  resetSmartTriggerState();

  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  const { api, state } = createApi({
    smart: { minIntervalMs: 0, cooldownMs: 0, maxRepliesPerHour: 0 },
    complete: async () => {
      await gate;
      return { text: '{"reply":true,"confidence":0.9,"reason":"提问"}' };
    },
  });

  const p1 = processInboundMessage(api, groupMessage("第一条未命中消息", [], { message_id: 1 }));
  const p2 = processInboundMessage(api, groupMessage("第二条未命中消息", [], { message_id: 2 }));

  // 等两条消息都进入触发检查：第一条占住判定权，第二条被 in-flight 拦下
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(state.llmCount, 1);
  assert.ok(
    state.logs.some((l) => l.includes("decision=skip reason=in-flight")),
    state.logs.join("\n"),
  );

  releaseGate();
  await Promise.all([p1, p2]);

  assert.equal(state.llmCount, 1, "同群并发只允许一次 LLM 判定");
  assert.equal(state.dispatchCount, 1, "只有拿到判定权的那条消息被放行");
});

// ---------------------------------------------------------------------------
// allowModelSilence / deliver 静默
// ---------------------------------------------------------------------------

test("allowModelSilence：放行后上下文注入沉默提示", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({
    smart: { allowModelSilence: true, silentMarker: "[[silent]]" },
  });

  await processInboundMessage(api, groupMessage("这个方案还有问题吧"));

  assert.equal(state.dispatchCount, 1);
  const body = state.bodies[0] ?? "";
  assert.ok(body.includes("【接话判定】"), body);
  assert.ok(body.includes("[[silent]]"), body);
});

test("allowModelSilence=false：上下文不注入沉默提示", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({ smart: { allowModelSilence: false } });

  await processInboundMessage(api, groupMessage("这个方案还有问题吧"));

  assert.equal(state.dispatchCount, 1);
  const body = state.bodies[0] ?? "";
  assert.equal(body.includes("【接话判定】"), false, body);
});

test("deliver 静默：模型只输出 silentMarker 时不触发任何发送", { timeout: 20000 }, async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({
    smart: { allowModelSilence: true, silentMarker: "[[silent]]" },
    deliverText: "[[silent]]",
  });
  // connection.ts 的 getLogger() 读 globalThis.__onebotApi.logger，便于断言“是否发起过发送”
  (globalThis as any).__onebotApi = api;
  try {
    await processInboundMessage(api, groupMessage("这个方案还有问题吧"));
  } finally {
    delete (globalThis as any).__onebotApi;
  }

  assert.equal(state.dispatchCount, 1);
  assert.equal(state.deliverCount, 1);
  // deliver 确实被调用（有进入日志）
  assert.ok(
    state.logs.some((l) => l.includes("deliver entry: kind=final")),
    state.logs.join("\n"),
  );
  // 发送路径未被触发：sendGroupMsg 会走 ensureConnection 并打出「连接 OneBot」日志
  assert.equal(
    state.logs.some((l) => l.includes("连接 OneBot")),
    false,
    `silentMarker 不应触发发送：\n${state.logs.join("\n")}`,
  );
});

test("deliver 非静默文本：会尝试走发送路径（对照用例）", { timeout: 20000 }, async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({
    smart: { allowModelSilence: true, silentMarker: "[[silent]]" },
    deliverText: "这是一条正常回复",
  });
  (globalThis as any).__onebotApi = api;
  try {
    await processInboundMessage(api, groupMessage("这个方案还有问题吧"));
  } finally {
    delete (globalThis as any).__onebotApi;
  }

  assert.equal(state.deliverCount, 1);
  assert.ok(
    state.logs.some((l) => l.includes("连接 OneBot")),
    `非静默文本应尝试发送（无 WS 时连接失败但不影响流程）：\n${state.logs.join("\n")}`,
  );
});

// ---------------------------------------------------------------------------
// 开关与群过滤
// ---------------------------------------------------------------------------

test("smartTrigger.enabled 缺省（false）：未 @ 消息不判定、不 dispatch", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({ smart: { enabled: false } });

  await processInboundMessage(api, groupMessage("今天天气不错"));

  assert.equal(state.llmCount, 0);
  assert.equal(state.dispatchCount, 0);
});

test("smartTrigger.groups 不含当前群：不判定、不 dispatch", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({ smart: { groups: [999999] } });

  await processInboundMessage(api, groupMessage("今天天气不错"));

  assert.equal(state.llmCount, 0);
  assert.equal(state.dispatchCount, 0);
});

test("smartTrigger.groups 含当前群（字符串配置）：正常判定", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({ smart: { groups: [String(GROUP_ID)] } });

  await processInboundMessage(api, groupMessage("今天天气不错"));

  assert.equal(state.llmCount, 1);
  assert.equal(state.dispatchCount, 1);
});

/**
 * 白名单/黑名单必须早于 LLM 判定（修复前缺陷：触发块早于白名单检查，
 * 白名单外用户未 @ 的群消息会白耗一次 LLM 判定并占冷却配额）。
 * 现在 smart 分支入口先做权限检查，命中则 skip reason=permission，不调 LLM、不 dispatch。
 */
test("白名单外用户的未 @ 群消息不消耗 LLM 判定", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({ smart: { minIntervalMs: 0, cooldownMs: 30000 } });
  api.config.channels.onebot.whitelistUserIds = [999];

  await processInboundMessage(api, groupMessage("今天天气不错"));

  assert.equal(state.llmCount, 0, "白名单外用户的消息不应触发 LLM 判定");
  assert.equal(state.dispatchCount, 0);
  assert.ok(state.logs.some((l) => l.includes("decision=skip reason=permission")));
});

test("过短消息（纯符号/单字）不判定，直接跳过", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({ smart: { minMessageChars: 2 } });

  await processInboundMessage(api, groupMessage("？"));

  assert.equal(state.llmCount, 0);
  assert.equal(state.dispatchCount, 0);
  assert.ok(
    state.logs.some((l) => l.includes("decision=skip reason=too-short")),
    state.logs.join("\n"),
  );
});

// ---------------------------------------------------------------------------
// 吐槽式接话（intent=sass）
// ---------------------------------------------------------------------------

test("intent=sass 放行：注入默认吐槽风格提示且日志带 intent=sass", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({
    complete: () => ({ text: '{"reply":true,"confidence":0.8,"intent":"sass","reason":"可以吐槽"}' }),
  });

  await processInboundMessage(api, groupMessage("我今天要开始健身了，这次一定能坚持"));

  assert.equal(state.dispatchCount, 1);
  assert.equal(state.llmCount, 1);
  assert.ok(state.bodies[0].includes("【接话风格】"), state.bodies[0]);
  assert.ok(state.bodies[0].includes("吐槽接梗"), state.bodies[0]);
  assert.ok(state.logs.some((l) => l.includes("decision=reply") && l.includes("intent=sass")));
});

test("sassStyle 自定义文案覆盖默认吐槽提示", async () => {
  resetSmartTriggerState();
  const custom = "【接话风格】用东北话损他一句，10 个字以内。";
  const { api, state } = createApi({
    smart: { sassStyle: custom },
    complete: () => ({ text: '{"reply":true,"confidence":0.8,"intent":"sass","reason":"可吐槽"}' }),
  });

  await processInboundMessage(api, groupMessage("我这次考试只复习了一晚上"));

  assert.equal(state.dispatchCount, 1);
  assert.ok(state.bodies[0].includes(custom), state.bodies[0]);
  assert.ok(!state.bodies[0].includes("不要长篇大论"), "默认文案应被完全替换");
});

test("intent=answer 不放行吐槽提示", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({
    complete: () => ({ text: '{"reply":true,"confidence":0.9,"intent":"answer","reason":"提问"}' }),
  });

  await processInboundMessage(api, groupMessage("怎么把 Docker 容器日志导出到文件"));

  assert.equal(state.dispatchCount, 1);
  assert.ok(!state.bodies[0].includes("【接话风格】"), state.bodies[0]);
});

test("sassEnabled=false：LLM 返回 intent=sass 也降级为 answer，不注入吐槽提示", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({
    smart: { sassEnabled: false },
    complete: () => ({ text: '{"reply":true,"confidence":0.8,"intent":"sass","reason":"可吐槽"}' }),
  });

  await processInboundMessage(api, groupMessage("我今天跑了五公里，感觉还行"));

  assert.equal(state.dispatchCount, 1);
  assert.ok(!state.bodies[0].includes("【接话风格】"), state.bodies[0]);
  assert.ok(state.logs.some((l) => l.includes("intent=answer")));
  // 判定 prompt 不应再提吐槽规则
  const systemPrompt = String(state.llmRequests[0]?.systemPrompt ?? "");
  assert.ok(!systemPrompt.includes("intent=\"sass\""), systemPrompt);
});

// ---------------------------------------------------------------------------
// 直通去重（连发触发词只回一次）
// ---------------------------------------------------------------------------

test("关键词触发词连发：minIntervalMs 内只放行一次，第二次 skip direct-repeat", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({ smart: { minIntervalMs: 3000, keywords: ["小鲸鱼"] } });

  await processInboundMessage(api, groupMessage("小鲸鱼 你个大肥鱼"));
  await processInboundMessage(api, groupMessage("小鲸鱼 你个大肥鱼"));

  assert.equal(state.dispatchCount, 1, "连发触发词应只回复一次");
  assert.equal(state.llmCount, 0, "直通不应消耗 LLM");
  assert.ok(state.logs.some((l) => l.includes("decision=skip reason=direct-repeat")));
});

// ---------------------------------------------------------------------------
// poke 等内部合成消息（__onebotForceDispatch）
// ---------------------------------------------------------------------------

test("__onebotForceDispatch（poke 合成消息）：跳过触发判定直接 dispatch", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({ smart: { minIntervalMs: 3000 } });

  await processInboundMessage(api, groupMessage("（戳了戳你）", [], { __onebotForceDispatch: true }));

  assert.equal(state.dispatchCount, 1, "合成消息应直接进入回复管线");
  assert.equal(state.llmCount, 0, "不应消耗判定 LLM");
});

// ---------------------------------------------------------------------------
// 引用机器人立即回复（quoteToBotReply）：deps.getMsg 注入假 get_msg
// ---------------------------------------------------------------------------

function replySegment(id: number) {
  return { type: "reply", data: { id: String(id) } };
}

/** 假 get_msg：返回 { message_id, sender:{nickname,user_id}, message:[{text}] } */
function quotedMsg(id: number, nickname: string, userId: number, text: string, quotedId?: number) {
  const message: any[] = [];
  if (quotedId != null) message.push({ type: "reply", data: { id: String(quotedId) } });
  message.push({ type: "text", data: { text } });
  return { message_id: id, sender: { nickname, user_id: userId }, message, message_type: "group" };
}

/** 注入给 processInboundMessage 的 deps.getMsg，并记录调用过的消息 ID */
function makeGetMsg(messages: Record<number, any>) {
  const calls: number[] = [];
  const getMsg = async (messageId: number) => {
    calls.push(messageId);
    return messages[messageId] ?? null;
  };
  return { getMsg, calls };
}

test("引用机器人：直接 dispatch 且不调用 LLM（智能触发关闭时同样生效）", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({ smart: { enabled: false } });
  const { getMsg, calls } = makeGetMsg({
    500: quotedMsg(500, "机器人", SELF_ID, "上一轮的回答内容"),
  });

  await processInboundMessage(api, groupMessage("继续说说", [replySegment(500)]), { getMsg });

  assert.equal(state.dispatchCount, 1);
  assert.equal(state.llmCount, 0);
  assert.deepEqual(calls, [500], "只直接引用了一条，且它没有更早的 reply 段");
  assert.ok(
    state.logs.some((l) => l.includes("[onebot] quote-chain") && l.includes("to=self")),
    state.logs.join("\n"),
  );
  assert.ok(
    state.logs.some((l) => l.includes("[onebot][smart]") && l.includes("decision=reply source=quote-to-bot")),
    state.logs.join("\n"),
  );
});

test("引用普通群友：不直通（智能触发关闭 + requireMention 时不 dispatch）", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({ smart: { enabled: false } });
  const { getMsg } = makeGetMsg({
    500: quotedMsg(500, "李四", USER_ID, "群友的发言"),
  });

  await processInboundMessage(api, groupMessage("继续说说", [replySegment(500)]), { getMsg });

  assert.equal(state.dispatchCount, 0);
  assert.equal(state.llmCount, 0);
  assert.ok(
    !state.logs.some((l) => l.includes("source=quote-to-bot")),
    state.logs.join("\n"),
  );
});

test("quoteToBotReply=false：引用机器人也不直通", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({ smart: { enabled: false } });
  api.config.channels.onebot.quoteToBotReply = false;
  const { getMsg } = makeGetMsg({
    500: quotedMsg(500, "机器人", SELF_ID, "上一轮的回答内容"),
  });

  await processInboundMessage(api, groupMessage("继续说说", [replySegment(500)]), { getMsg });

  assert.equal(state.dispatchCount, 0);
  assert.equal(state.llmCount, 0);
  assert.ok(
    !state.logs.some((l) => l.includes("source=quote-to-bot")),
    state.logs.join("\n"),
  );
});

test("间接引用：引用群友发起的链（更早节点才是机器人）不算直通", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({ smart: { enabled: false } });
  const { getMsg, calls } = makeGetMsg({
    1: quotedMsg(1, "机器人", SELF_ID, "机器人的原始回答"),
    2: quotedMsg(2, "李四", USER_ID, "李四引用了机器人", 1),
  });

  await processInboundMessage(api, groupMessage("我也来说一句", [replySegment(2)]), { getMsg });

  assert.equal(state.dispatchCount, 0, "只有直接引用机器人（链尾）才直通");
  assert.equal(state.llmCount, 0);
  assert.deepEqual(calls, [2, 1], "应沿 reply 段上溯取回整条链");
  assert.ok(
    !state.logs.some((l) => l.includes("source=quote-to-bot")),
    state.logs.join("\n"),
  );
});

test("引用机器人 + allowModelSilence：Body 带引用链文本且不注入沉默提示", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({
    smart: { enabled: true, allowModelSilence: true, silentMarker: "[[silent]]" },
  });
  const { getMsg } = makeGetMsg({
    500: quotedMsg(500, "机器人", SELF_ID, "上一轮的回答内容"),
  });

  await processInboundMessage(api, groupMessage("继续说说", [replySegment(500)]), { getMsg });

  assert.equal(state.dispatchCount, 1);
  assert.equal(state.llmCount, 0, "引用机器人不应消耗 LLM 判定");
  const body = state.bodies[0] ?? "";
  assert.ok(body.includes("[引用 机器人 的消息（#500）"), body);
  assert.ok(body.includes("继续说说"), body);
  assert.equal(body.includes("【接话判定】"), false, body);
});

test("引用机器人但 get_msg 取不到（已撤回）：不直通、不崩溃", async () => {
  resetSmartTriggerState();
  const { api, state } = createApi({ smart: { enabled: false } });
  const { getMsg, calls } = makeGetMsg({}); // 一律返回 null

  await processInboundMessage(api, groupMessage("继续说说", [replySegment(500)]), { getMsg });

  assert.equal(calls.length, 1);
  assert.equal(state.dispatchCount, 0);
  assert.equal(state.llmCount, 0);
  assert.ok(
    !state.logs.some((l) => l.includes("source=quote-to-bot")),
    state.logs.join("\n"),
  );
});
