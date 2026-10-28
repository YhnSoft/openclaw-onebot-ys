/**
 * 智能触发（smart trigger）单元测试 —— 对应 smart-trigger-spec.md §9
 *
 * 运行：npx tsx --test test/smart-trigger.test.ts
 *
 * 覆盖：getSmartTriggerConfig 解析/clamp/继承、matchDirectTrigger、
 *       成本护栏（min-interval / cooldown / hourly-limit）、begin/end 原子性、
 *       parseJudgeJson、buildJudgePrompt、judgeGroupMessage 全部分支。
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { SmartTriggerConfig } from "../src/config.js";
import { getSmartTriggerConfig } from "../src/config.js";
import { getAtTargets } from "../src/message.js";
import {
  matchDirectTrigger,
  checkSmartTriggerGuards,
  noteSmartTriggerJudge,
  noteSmartTriggerReply,
  beginSmartTriggerJudge,
  endSmartTriggerJudge,
  resetSmartTriggerState,
  shouldSkipDirectTrigger,
  noteDirectTrigger,
  parseJudgeJson,
  buildJudgePrompt,
  judgeGroupMessage,
} from "../src/smart-trigger.js";

const GROUP = 1046693162;
const OTHER_GROUP = 2000000001;

/** 构造完整配置：始终走 getSmartTriggerConfig，保证与生产解析路径一致 */
function makeSmart(overrides: Record<string, unknown> = {}): SmartTriggerConfig {
  return getSmartTriggerConfig({ channels: { onebot: { smartTrigger: { ...overrides } } } });
}

// ---------------------------------------------------------------------------
// getSmartTriggerConfig
// ---------------------------------------------------------------------------

test("getSmartTriggerConfig: 默认值与 spec §2 一致", () => {
  const c = getSmartTriggerConfig({});
  assert.equal(c.enabled, false);
  assert.deepEqual(c.groups, []);
  assert.deepEqual(c.keywords, []);
  assert.equal(c.keywordMode, "contains");
  assert.deepEqual(c.aliases, []);
  assert.equal(c.threshold, 0.6);
  assert.equal(c.timeoutMs, 8000);
  assert.equal(c.minIntervalMs, 3000);
  assert.equal(c.cooldownMs, 30000);
  assert.equal(c.maxRepliesPerHour, 6);
  assert.equal(c.historyLimit, 10);
  assert.equal(c.maxInputChars, 2000);
  assert.equal(c.model, "");
  assert.equal(c.fallback, "ignore");
  assert.equal(c.minMessageChars, 2);
  assert.equal(c.allowModelSilence, false);
  assert.equal(c.silentMarker, "[[silent]]");
});

test("getSmartTriggerConfig: requireMention=true 不会默认开启智能触发", () => {
  const c = getSmartTriggerConfig({ channels: { onebot: { requireMention: true } } });
  assert.equal(c.enabled, false);
  const c2 = getSmartTriggerConfig({ channels: { onebot: { requireMention: true, smartTrigger: { enabled: true } } } });
  assert.equal(c2.enabled, true);
});

test("getSmartTriggerConfig: 数值 clamp 到 spec 范围", () => {
  const high = makeSmart({
    threshold: 5,
    timeoutMs: 10,
    minIntervalMs: -1,
    cooldownMs: 9_999_999,
    maxRepliesPerHour: 999,
    historyLimit: 99,
    maxInputChars: 10,
    minMessageChars: 999,
  });
  assert.equal(high.threshold, 1);
  assert.equal(high.timeoutMs, 1000);
  assert.equal(high.minIntervalMs, 0);
  assert.equal(high.cooldownMs, 3_600_000);
  assert.equal(high.maxRepliesPerHour, 100);
  assert.equal(high.historyLimit, 30);
  assert.equal(high.maxInputChars, 200);
  assert.equal(high.minMessageChars, 200);

  const low = makeSmart({ threshold: -3, timeoutMs: 999_999, cooldownMs: -100 });
  assert.equal(low.threshold, 0);
  assert.equal(low.timeoutMs, 60_000);
  assert.equal(low.cooldownMs, 0);
});

test("getSmartTriggerConfig: 非法类型回落默认值", () => {
  const c = makeSmart({
    enabled: "true",
    threshold: "0.9",
    cooldownMs: "30000",
    maxRepliesPerHour: Number.NaN,
    silentMarker: "   ",
    keywordMode: "fuzzy",
    fallback: "maybe",
    groups: "123",
    aliases: [1, null, "  ", "小助手"],
  });
  assert.equal(c.enabled, false);
  assert.equal(c.threshold, 0.6);
  assert.equal(c.cooldownMs, 30000);
  assert.equal(c.maxRepliesPerHour, 6);
  assert.equal(c.silentMarker, "[[silent]]");
  assert.equal(c.keywordMode, "contains");
  assert.equal(c.fallback, "ignore");
  assert.deepEqual(c.groups, []);
  assert.deepEqual(c.aliases, ["小助手"]);

  // keywordMode 只认 prefix，其余一律 contains
  assert.equal(makeSmart({ keywordMode: "prefix" }).keywordMode, "prefix");
  assert.equal(makeSmart({ keywordMode: "CONTAINS" }).keywordMode, "contains");
});

test("getSmartTriggerConfig: 任意垃圾输入都不抛错", () => {
  const garbage = [
    null,
    undefined,
    42,
    "x",
    [],
    { channels: null },
    { channels: { onebot: null } },
    { channels: { onebot: { smartTrigger: "oops" } } },
    { channels: { onebot: { smartTrigger: { groups: {} } } } },
  ];
  for (const bad of garbage) {
    assert.doesNotThrow(() => getSmartTriggerConfig(bad));
    assert.equal(getSmartTriggerConfig(bad).enabled, false);
  }
});

test("getSmartTriggerConfig: keywords 为空时继承 triggerKeywords", () => {
  const inherited = getSmartTriggerConfig({
    channels: { onebot: { triggerKeywords: [" 机器人 ", "", 42], smartTrigger: { keywords: [] } } },
  });
  assert.deepEqual(inherited.keywords, ["机器人"]);

  const explicit = getSmartTriggerConfig({
    channels: { onebot: { triggerKeywords: ["机器人"], smartTrigger: { keywords: [" 小助手 "] } } },
  });
  assert.deepEqual(explicit.keywords, ["小助手"]);

  const none = getSmartTriggerConfig({ channels: { onebot: { smartTrigger: {} } } });
  assert.deepEqual(none.keywords, []);
});

test("getSmartTriggerConfig: groups 字符串数字转 number", () => {
  const c = makeSmart({ groups: ["123456", 789, "bad", "  42  ", 3.5, null] });
  assert.deepEqual(c.groups, [123456, 789, 42, 3.5]);
});

// ---------------------------------------------------------------------------
// matchDirectTrigger
// ---------------------------------------------------------------------------

test("matchDirectTrigger: contains 命中关键词", () => {
  const smart = makeSmart({ keywords: ["你好", "在吗"], keywordMode: "contains" });
  assert.equal(matchDirectTrigger("大家好，你好吗", smart), "你好");
  assert.equal(matchDirectTrigger("请问在吗？", smart), "在吗");
  assert.equal(matchDirectTrigger("今天吃什么", smart), null);
});

test("matchDirectTrigger: prefix 模式只认开头", () => {
  const smart = makeSmart({ keywords: ["/问"], keywordMode: "prefix" });
  assert.equal(matchDirectTrigger("/问 今天天气", smart), "/问");
  assert.equal(matchDirectTrigger("   /问 今天天气", smart), "/问");
  assert.equal(matchDirectTrigger("请问/问 今天天气", smart), null);
});

test("matchDirectTrigger: 大小写不敏感", () => {
  const smart = makeSmart({ keywords: ["Hello"], aliases: ["Bot"] });
  assert.equal(matchDirectTrigger("HELLO 世界", smart), "Hello");
  assert.equal(matchDirectTrigger("问问 BOT 在不在", smart), "Bot");
});

test("matchDirectTrigger: aliases 包含匹配直通（不受 keywordMode 影响）", () => {
  const smart = makeSmart({ keywords: ["/问"], keywordMode: "prefix", aliases: ["小助手"] });
  assert.equal(matchDirectTrigger("请问小助手今天有空吗", smart), "小助手");
  assert.equal(matchDirectTrigger("小助手", smart), "小助手");
  assert.equal(matchDirectTrigger("今天吃什么", smart), null);
});

test("matchDirectTrigger: 空文本/非字符串返回 null", () => {
  const smart = makeSmart({ keywords: ["你好"], aliases: ["小助手"] });
  assert.equal(matchDirectTrigger("", smart), null);
  assert.equal(matchDirectTrigger("   ", smart), null);
  assert.equal(matchDirectTrigger("   \n\t ", smart), null);
  assert.equal(matchDirectTrigger(undefined as unknown as string, smart), null);
  assert.equal(matchDirectTrigger(null as unknown as string, smart), null);
});

// ---------------------------------------------------------------------------
// 成本护栏
// ---------------------------------------------------------------------------

test("护栏: min-interval 生效（用 now 推进时间）", () => {
  resetSmartTriggerState();
  const smart = makeSmart({ minIntervalMs: 3000, cooldownMs: 0, maxRepliesPerHour: 0 });

  assert.equal(checkSmartTriggerGuards(smart, GROUP, 1000).allowed, true);
  noteSmartTriggerJudge(GROUP, 1000);

  const blocked = checkSmartTriggerGuards(smart, GROUP, 1000 + 2999);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "min-interval");

  assert.equal(checkSmartTriggerGuards(smart, GROUP, 1000 + 3000).allowed, true);
  // 其他群不受影响
  assert.equal(checkSmartTriggerGuards(smart, OTHER_GROUP, 1001).allowed, true);
});

test("护栏: cooldown 生效（放行回复后同群冷却）", () => {
  resetSmartTriggerState();
  const smart = makeSmart({ minIntervalMs: 0, cooldownMs: 30000, maxRepliesPerHour: 0 });

  noteSmartTriggerReply(GROUP, 5000);
  const blocked = checkSmartTriggerGuards(smart, GROUP, 5000 + 29_999);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "cooldown");

  assert.equal(checkSmartTriggerGuards(smart, GROUP, 5000 + 30_000).allowed, true);
});

test("护栏: hourly-limit 生效且只统计最近一小时", () => {
  resetSmartTriggerState();
  const smart = makeSmart({ minIntervalMs: 0, cooldownMs: 0, maxRepliesPerHour: 2 });

  noteSmartTriggerReply(GROUP, 1000);
  noteSmartTriggerReply(GROUP, 2000);

  const blocked = checkSmartTriggerGuards(smart, GROUP, 3000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "hourly-limit");

  // 第一次放行滑出 1 小时窗口后恢复
  assert.equal(checkSmartTriggerGuards(smart, GROUP, 1000 + 3_600_000).allowed, true);
});

test("护栏: maxRepliesPerHour=0 表示不限", () => {
  resetSmartTriggerState();
  const smart = makeSmart({ minIntervalMs: 0, cooldownMs: 0, maxRepliesPerHour: 0 });

  for (let i = 0; i < 20; i++) noteSmartTriggerReply(GROUP, 1000 + i);
  assert.equal(checkSmartTriggerGuards(smart, GROUP, 2000).allowed, true);
});

// ---------------------------------------------------------------------------
// begin / end 并发原子性
// ---------------------------------------------------------------------------

test("begin/end: 同群并发只允许一次判定，end 后可再次 begin", () => {
  resetSmartTriggerState();
  const smart = makeSmart({ minIntervalMs: 3000, cooldownMs: 0, maxRepliesPerHour: 0 });

  const first = beginSmartTriggerJudge(smart, GROUP, 1000);
  assert.equal(first.allowed, true);

  // 已过 min-interval，因此第二次被拒唯一原因就是 in-flight
  const second = beginSmartTriggerJudge(smart, GROUP, 1000 + 5000);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, "in-flight");

  // 另一个群不受该群的 in-flight 影响
  const otherGroup = beginSmartTriggerJudge(smart, OTHER_GROUP, 1000 + 5000);
  assert.equal(otherGroup.allowed, true);

  endSmartTriggerJudge(GROUP);
  const afterEnd = beginSmartTriggerJudge(smart, GROUP, 1000 + 10_000);
  assert.equal(afterEnd.allowed, true);

  endSmartTriggerJudge(GROUP);
  endSmartTriggerJudge(OTHER_GROUP);
});

test("begin/end: 被 in-flight 拒绝时不覆盖 lastJudgeAt", () => {
  resetSmartTriggerState();
  const smart = makeSmart({ minIntervalMs: 3000, cooldownMs: 0, maxRepliesPerHour: 0 });

  assert.equal(beginSmartTriggerJudge(smart, GROUP, 1000).allowed, true);
  assert.equal(beginSmartTriggerJudge(smart, GROUP, 6000).reason, "in-flight");
  endSmartTriggerJudge(GROUP);

  // lastJudgeAt 仍为 1000：8000 - 1000 > 3000
  assert.equal(checkSmartTriggerGuards(smart, GROUP, 8000).allowed, true);
  assert.equal(checkSmartTriggerGuards(smart, GROUP, 3999).allowed, false);
  assert.equal(checkSmartTriggerGuards(smart, GROUP, 3999).reason, "min-interval");
});

test("resetSmartTriggerState: 清空护栏与 in-flight 状态", () => {
  resetSmartTriggerState();
  const smart = makeSmart({ minIntervalMs: 600000, cooldownMs: 3_600_000, maxRepliesPerHour: 1 });

  assert.equal(beginSmartTriggerJudge(smart, GROUP, 1000).allowed, true);
  noteSmartTriggerReply(GROUP, 1000);
  assert.equal(checkSmartTriggerGuards(smart, GROUP, 1001).allowed, false);

  resetSmartTriggerState();
  assert.equal(checkSmartTriggerGuards(smart, GROUP, 1002).allowed, true);
  assert.equal(beginSmartTriggerJudge(smart, GROUP, 1003).allowed, true);
  endSmartTriggerJudge(GROUP);
});

// ---------------------------------------------------------------------------
// parseJudgeJson
// ---------------------------------------------------------------------------

test("parseJudgeJson: 纯 JSON", () => {
  assert.deepEqual(parseJudgeJson('{"reply":true,"confidence":0.9,"reason":"提问"}'), {
    reply: true,
    confidence: 0.9,
    reason: "提问",
  });
});

test("parseJudgeJson: markdown 代码围栏", () => {
  const parsed = parseJudgeJson('好的，判断如下：\n```json\n{"reply":false,"confidence":0.2,"reason":"闲聊"}\n```\n以上。');
  assert.equal(parsed?.reply, false);
  assert.equal(parsed?.confidence, 0.2);
  assert.equal(parsed?.reason, "闲聊");

  const noLang = parseJudgeJson('```\n{"reply":true,"confidence":0.7}\n```');
  assert.equal(noLang?.reply, true);
});

test("parseJudgeJson: 前后噪声", () => {
  const parsed = parseJudgeJson('我认为应该接话。{"reply":true,"confidence":0.82} 就这样。');
  assert.deepEqual(parsed, { reply: true, confidence: 0.82 });
});

test("parseJudgeJson: 非法文本返回 null", () => {
  assert.equal(parseJudgeJson("这不是 JSON"), null);
  assert.equal(parseJudgeJson(""), null);
  assert.equal(parseJudgeJson("   "), null);
  assert.equal(parseJudgeJson('{"confidence":0.9}'), null);
  assert.equal(parseJudgeJson('{"reply":"yes"}'), null);
  assert.equal(parseJudgeJson("{reply:true}"), null);
  assert.equal(parseJudgeJson("[true,false]"), null);
});

test("parseJudgeJson: confidence 越界被 clamp、字符串数字被接受", () => {
  assert.equal(parseJudgeJson('{"reply":true,"confidence":1.7}')?.confidence, 1);
  assert.equal(parseJudgeJson('{"reply":true,"confidence":-2}')?.confidence, 0);
  assert.equal(parseJudgeJson('{"reply":false,"confidence":"0.35"}')?.confidence, 0.35);
  assert.equal(parseJudgeJson('{"reply":true}')?.confidence, undefined);
});

// ---------------------------------------------------------------------------
// buildJudgePrompt
// ---------------------------------------------------------------------------

test("buildJudgePrompt: system 要求只输出 JSON，user 含历史/当前消息/引用/别名", () => {
  const prompt = buildJudgePrompt({
    smart: makeSmart(),
    senderLabel: "张三(qq: 10001)",
    messageText: "机器人你好",
    recentMessages: [{ sender: "李四(qq: 10002)", body: "hello" }],
    quotedText: "之前的话",
    aliases: ["小助手"],
  });
  assert.match(prompt.systemPrompt, /JSON/);
  assert.ok(prompt.systemPrompt.includes('"reply"'));
  assert.ok(prompt.systemPrompt.includes('"confidence"'));
  assert.ok(prompt.systemPrompt.includes('"reason"'));
  assert.ok(prompt.systemPrompt.includes("拿不准"));
  assert.ok(prompt.userPrompt.includes("【机器人别名】小助手"));
  assert.ok(prompt.userPrompt.includes("【当前时间】"));
  assert.ok(prompt.userPrompt.includes("【最近群聊记录】"));
  assert.ok(prompt.userPrompt.includes("李四(qq: 10002): hello"));
  assert.ok(prompt.userPrompt.includes("【被引用的消息】"));
  assert.ok(prompt.userPrompt.includes("之前的话"));
  assert.ok(prompt.userPrompt.includes("【当前消息】"));
  assert.ok(prompt.userPrompt.includes("张三(qq: 10001): 机器人你好"));
});

test("buildJudgePrompt: 历史总量遵守 maxInputChars 预算", () => {
  const prompt = buildJudgePrompt({
    smart: makeSmart({ maxInputChars: 200 }),
    senderLabel: "张三",
    messageText: "在吗",
    recentMessages: [{ sender: "李四", body: "长".repeat(300) }],
    aliases: [],
  });
  // 单条历史截断后仍超预算 → 整条丢弃
  assert.equal(prompt.userPrompt.includes("【最近群聊记录】"), false);

  const prompt2 = buildJudgePrompt({
    smart: makeSmart({ maxInputChars: 200 }),
    senderLabel: "张三",
    messageText: "在吗",
    recentMessages: [{ sender: "李四", body: "短消息" }],
    aliases: [],
  });
  assert.ok(prompt2.userPrompt.includes("【最近群聊记录】"));
});

test("getAtTargets: 提取 @ 目标并过滤 @全体成员/非法值", () => {
  const msg: any = {
    message: [
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 你好" } },
      { type: "at", data: { qq: "all" } },
      { type: "at", data: { id: 67890 } },
      { type: "at", data: {} },
    ],
  };
  assert.deepEqual(getAtTargets(msg), [12345, 67890]);
  assert.deepEqual(getAtTargets({} as any), []);
  assert.deepEqual(getAtTargets({ message: "not-array" } as any), []);
});

test("getSmartTriggerConfig: judgePersona 默认空串（由内置人设接管）", () => {
  assert.equal(getSmartTriggerConfig({}).judgePersona, "");
  assert.equal(makeSmart({ judgePersona: "  一只测试用的猫  " }).judgePersona, "一只测试用的猫");
});

test("buildJudgePrompt: 注入人设摘要（默认小鲸鱼 / judgePersona 覆盖）", () => {
  const def = buildJudgePrompt({
    smart: makeSmart(),
    senderLabel: "张三",
    messageText: "在吗",
    recentMessages: [],
    aliases: [],
  });
  assert.ok(def.systemPrompt.includes("【机器人是谁】"));
  assert.ok(def.systemPrompt.includes("小鲸鱼"));
  assert.ok(def.systemPrompt.includes("不是客服"));

  const custom = buildJudgePrompt({
    smart: makeSmart({ judgePersona: "一只测试用的猫" }),
    senderLabel: "张三",
    messageText: "在吗",
    recentMessages: [],
    aliases: [],
  });
  assert.ok(custom.systemPrompt.includes("【机器人是谁】一只测试用的猫"));
  // 默认人设的特征句应被替换掉（规则里的「小鲸鱼」是举例，不算人设）
  assert.equal(custom.systemPrompt.includes("辉の大肥鱼"), false);
});

test("buildJudgePrompt: @别人 与 @机器人 在 user 里标注不同", () => {
  const toOthers = buildJudgePrompt({
    smart: makeSmart(),
    senderLabel: "张三(qq: 10001)",
    messageText: "@20002 晚上吃啥",
    recentMessages: [],
    aliases: ["小鲸鱼"],
    atTargets: [20002],
    selfId: 99999,
  });
  assert.ok(toOthers.userPrompt.includes("【本条消息 @ 了】@20002（其他群友）"));
  assert.ok(toOthers.systemPrompt.includes("@ 了谁"));
  assert.ok(toOthers.systemPrompt.includes("其他群友"));

  const toSelf = buildJudgePrompt({
    smart: makeSmart(),
    senderLabel: "张三",
    messageText: "在吗",
    recentMessages: [],
    aliases: [],
    atTargets: [99999],
    selfId: 99999,
  });
  assert.ok(toSelf.userPrompt.includes("@99999（机器人自己）"));
});

test("buildJudgePrompt: 没有 at 目标时不输出【本条消息 @ 了】", () => {
  const prompt = buildJudgePrompt({
    smart: makeSmart(),
    senderLabel: "张三",
    messageText: "在吗",
    recentMessages: [],
    aliases: [],
  });
  assert.equal(prompt.userPrompt.includes("【本条消息 @ 了】"), false);
});

test("buildJudgePrompt: @ 目标带昵称时标注「不是机器人」，并给出机器人自己的 QQ", () => {
  const prompt = buildJudgePrompt({
    smart: makeSmart(),
    senderLabel: "张三(qq: 10001)",
    messageText: "@20002 晚上吃啥",
    recentMessages: [],
    aliases: ["小鲸鱼"],
    atTargets: [{ qq: 20002, name: "大肥鱼" }, 99999],
    selfId: 99999,
  });
  assert.ok(prompt.userPrompt.includes("【机器人自己的 QQ】99999"));
  assert.ok(prompt.userPrompt.includes("@20002（其他群友「大肥鱼」，不是机器人）"));
  assert.ok(prompt.userPrompt.includes("@99999（机器人自己）"));
  assert.ok(prompt.systemPrompt.includes("认 QQ 不认名字"));
});

// ---------------------------------------------------------------------------
// judgeGroupMessage
// ---------------------------------------------------------------------------

interface JudgeApiBox {
  api: any;
  logs: Array<{ level: string; msg: string }>;
  requests: any[];
}

function makeJudgeApi(options: { withLlm?: boolean; complete?: (req: any) => any } = {}): JudgeApiBox {
  const logs: Array<{ level: string; msg: string }> = [];
  const requests: any[] = [];
  const api: any = {
    config: {},
    logger: {
      info: (m: string) => logs.push({ level: "info", msg: String(m) }),
      warn: (m: string) => logs.push({ level: "warn", msg: String(m) }),
      error: (m: string) => logs.push({ level: "error", msg: String(m) }),
    },
  };
  if (options.withLlm !== false) {
    api.runtime = {
      llm: {
        complete: async (req: any) => {
          requests.push(req);
          if (options.complete) return await options.complete(req);
          return { text: '{"reply":true,"confidence":0.9,"reason":"提问"}' };
        },
      },
    };
  }
  return { api, logs, requests };
}

function judgeOnce(smartOverrides: Record<string, unknown>, box: JudgeApiBox) {
  return judgeGroupMessage({
    api: box.api,
    smart: makeSmart(smartOverrides),
    groupId: GROUP,
    selfId: 99999,
    senderLabel: "张三(qq: 10001)",
    messageText: "这个问题怎么解决？",
    recentMessages: [{ sender: "李四(qq: 10002)", body: "我想问下部署流程" }],
    quotedText: "上一轮的部署说明",
  });
}

test("judgeGroupMessage: LLM 返回合法 JSON → reply=true 且参数符合契约", async () => {
  const box = makeJudgeApi();
  const verdict = await judgeOnce({ threshold: 0.6 }, box);

  assert.equal(verdict.reply, true);
  assert.equal(verdict.source, "llm");
  assert.equal(verdict.confidence, 0.9);
  assert.equal(verdict.reason, "提问");
  assert.ok(typeof verdict.latencyMs === "number" && verdict.latencyMs >= 0);

  assert.equal(box.requests.length, 1);
  const req = box.requests[0];
  assert.equal(req.purpose, "onebot.smart-trigger");
  assert.equal(req.maxTokens, 256);
  assert.equal(req.temperature, 0);
  assert.equal(Array.isArray(req.messages), true);
  assert.equal(req.messages.length, 1);
  assert.equal(req.messages[0].role, "user");
  assert.match(req.messages[0].content, /【当前消息】/);
  assert.equal(typeof req.systemPrompt, "string");
  assert.ok("signal" in req);
  // 未配置 model 时不透传 model
  assert.equal("model" in req, false);
});

test("judgeGroupMessage: confidence 低于 threshold → reply=false 但 source=llm", async () => {
  const box = makeJudgeApi({
    complete: () => ({ text: '{"reply":true,"confidence":0.3,"reason":"拿不准"}' }),
  });
  const verdict = await judgeOnce({ threshold: 0.6 }, box);
  assert.equal(verdict.reply, false);
  assert.equal(verdict.source, "llm");
  assert.equal(verdict.confidence, 0.3);
});

test("judgeGroupMessage: confidence 恰好等于 threshold → reply=true", async () => {
  const box = makeJudgeApi({ complete: () => ({ text: '{"reply":true,"confidence":0.6}' }) });
  const verdict = await judgeOnce({ threshold: 0.6 }, box);
  assert.equal(verdict.reply, true);
  assert.equal(verdict.source, "llm");
});

test("judgeGroupMessage: 返回乱码 → fallback(ignore) 且写 warn 日志", async () => {
  const box = makeJudgeApi({ complete: () => ({ text: "我觉得可以接话" }) });
  const verdict = await judgeOnce({ fallback: "ignore" }, box);
  assert.equal(verdict.reply, false);
  assert.equal(verdict.source, "fallback");
  assert.ok(verdict.error?.startsWith("parse-failed"), verdict.error);
  assert.ok(verdict.error?.includes("我觉得可以接话"), "错误信息应带模型输出片段便于排查");
  assert.ok(
    box.logs.some((l) => l.level === "warn" && l.msg.includes("[onebot][smart]") && l.msg.includes("decision=fallback")),
    JSON.stringify(box.logs),
  );
});

test("judgeGroupMessage: 无 api.runtime.llm → fallback(llm-unavailable)", async () => {
  const box = makeJudgeApi({ withLlm: false });
  const verdict = await judgeOnce({ fallback: "ignore" }, box);
  assert.equal(verdict.reply, false);
  assert.equal(verdict.source, "fallback");
  assert.equal(verdict.error, "llm-unavailable");
  assert.equal(box.requests.length, 0);
});

test("judgeGroupMessage: 无 llm 但 fallback=reply → 放行", async () => {
  const box = makeJudgeApi({ withLlm: false });
  const verdict = await judgeOnce({ fallback: "reply" }, box);
  assert.equal(verdict.reply, true);
  assert.equal(verdict.source, "fallback");
  assert.equal(verdict.error, "llm-unavailable");
});

test("judgeGroupMessage: complete 抛错 → fallback(ignore) 且截断错误信息", async () => {
  const box = makeJudgeApi({
    complete: () => {
      throw new Error("socket hang up");
    },
  });
  const verdict = await judgeOnce({ fallback: "ignore" }, box);
  assert.equal(verdict.reply, false);
  assert.equal(verdict.source, "fallback");
  assert.match(verdict.error ?? "", /socket hang up/);
  assert.ok((verdict.error ?? "").length <= 200);
});

test("judgeGroupMessage: model 配置透传到请求", async () => {
  const box = makeJudgeApi();
  const verdict = await judgeOnce({ model: "deepseek/deepseek-flash" }, box);
  assert.equal(box.requests[0].model, "deepseek/deepseek-flash");
  assert.equal(verdict.model, "deepseek/deepseek-flash");
});

test("judgeGroupMessage: 超过 timeoutMs 判定失败 → fallback(timeout)", async () => {
  const box = makeJudgeApi({ complete: () => new Promise(() => {}) });
  const startedAt = Date.now();
  const verdict = await judgeOnce({ timeoutMs: 1000, fallback: "ignore" }, box);
  assert.equal(verdict.source, "fallback");
  assert.equal(verdict.reply, false);
  assert.equal(verdict.error, "timeout");
  assert.ok(Date.now() - startedAt >= 900);
});

// ---------------------------------------------------------------------------
// 吐槽式接话（intent）
// ---------------------------------------------------------------------------

test("parseJudgeJson: 解析 intent=sass / answer，非法值忽略", () => {
  assert.equal(parseJudgeJson('{"reply":true,"confidence":0.8,"intent":"sass"}')?.intent, "sass");
  assert.equal(parseJudgeJson('{"reply":true,"confidence":0.8,"intent":"answer"}')?.intent, "answer");
  assert.equal(parseJudgeJson('{"reply":true,"confidence":0.8,"intent":"SHOUT"}')?.intent, undefined);
  assert.equal(parseJudgeJson('{"reply":true,"confidence":0.8}')?.intent, undefined);
});

test("buildJudgePrompt: sassEnabled=true 时包含吐槽规则与 intent 约定", () => {
  const { systemPrompt } = buildJudgePrompt({
    smart: makeSmart({ sassEnabled: true }),
    senderLabel: "张三",
    messageText: "我这次一定会坚持健身",
    recentMessages: [],
    aliases: [],
  });
  assert.ok(systemPrompt.includes("可吐槽素材"), systemPrompt);
  assert.ok(systemPrompt.includes('"intent"'), systemPrompt);
  assert.ok(systemPrompt.includes("吐槽要短"), systemPrompt);
  assert.ok(systemPrompt.includes("冒犯"), systemPrompt);
});

test("buildJudgePrompt: sassEnabled=false 时只有认真回答规则", () => {
  const { systemPrompt } = buildJudgePrompt({
    smart: makeSmart({ sassEnabled: false }),
    senderLabel: "张三",
    messageText: "我这次一定会坚持健身",
    recentMessages: [],
    aliases: [],
  });
  assert.ok(!systemPrompt.includes("可吐槽素材"), systemPrompt);
  assert.ok(!systemPrompt.includes("intent"), systemPrompt);
});

test("judgeGroupMessage: 放行且模型给 sass → intent=sass", async () => {
  const box = makeJudgeApi({
    complete: () => ({ text: '{"reply":true,"confidence":0.8,"intent":"sass","reason":"可吐槽"}' }),
  });
  const verdict = await judgeOnce({ sassEnabled: true }, box);
  assert.equal(verdict.reply, true);
  assert.equal(verdict.intent, "sass");
});

test("judgeGroupMessage: sassEnabled=false 时 intent 降级为 answer", async () => {
  const box = makeJudgeApi({
    complete: () => ({ text: '{"reply":true,"confidence":0.8,"intent":"sass"}' }),
  });
  const verdict = await judgeOnce({ sassEnabled: false }, box);
  assert.equal(verdict.reply, true);
  assert.equal(verdict.intent, "answer");
});

test("judgeGroupMessage: reply=false 时 intent 为 undefined", async () => {
  const box = makeJudgeApi({
    complete: () => ({ text: '{"reply":false,"confidence":0.3,"intent":"sass"}' }),
  });
  const verdict = await judgeOnce({ sassEnabled: true }, box);
  assert.equal(verdict.reply, false);
  assert.equal(verdict.intent, undefined);
});

// ---------------------------------------------------------------------------
// 直通去重（防连发刷屏）
// ---------------------------------------------------------------------------

test("直通去重: minIntervalMs 内重复触发词被跳过，之后恢复", () => {
  resetSmartTriggerState();
  const smart = makeSmart({ minIntervalMs: 3000 });
  const t = 1_000_000;

  assert.equal(shouldSkipDirectTrigger(smart, GROUP, t), false);
  noteDirectTrigger(GROUP, t);
  assert.equal(shouldSkipDirectTrigger(smart, GROUP, t + 1000), true);
  assert.equal(shouldSkipDirectTrigger(smart, GROUP, t + 3000), false);
  // 跨群隔离
  assert.equal(shouldSkipDirectTrigger(smart, OTHER_GROUP, t + 1000), false);
});

test("直通去重: minIntervalMs=0 时不去重", () => {
  resetSmartTriggerState();
  const smart = makeSmart({ minIntervalMs: 0 });
  noteDirectTrigger(GROUP, 1_000_000);
  assert.equal(shouldSkipDirectTrigger(smart, GROUP, 1_000_001), false);
});

test("直通去重: 与 LLM 判定共用最小间隔（直通后紧接的消息不判定）", () => {
  resetSmartTriggerState();
  const smart = makeSmart({ minIntervalMs: 3000 });
  const t = 2_000_000;
  noteDirectTrigger(GROUP, t);
  const guard = beginSmartTriggerJudge(smart, GROUP, t + 500);
  assert.equal(guard.allowed, false);
  assert.equal(guard.reason, "min-interval");
});
