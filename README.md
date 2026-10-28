<div align="center">

# openclaw-onebot

[OpenClaw](https://openclaw.ai)  的 **OneBot v11 协议**（QQ/Lagrange.Core、go-cqhttp 等）渠道插件。

[![npm version](https://img.shields.io/npm/v/@kirigaya/openclaw-onebot?style=flat-square)](https://www.npmjs.com/package/@kirigaya/openclaw-onebot)
[![GitHub stars](https://img.shields.io/github/stars/LSTM-Kirigaya/openclaw-onebot?style=flat-square)](https://github.com/LSTM-Kirigaya/openclaw-onebot)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat-square)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?style=flat-square)](https://www.typescriptlang.org/)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-Plugin-9cf?style=flat-square)](https://openclaw.ai)

</div>

---

**概览**：当前版本 **v1.3.0**。群聊支持 @ / 关键词 / 两段式智能触发（LLM 判定 + 成本护栏）、引用链展开与「引用机器人即回复」、戳一戳回应、表情包 / 图片 / 文件 / 撤回；同时向 Agent 注册 `onebot_*` 工具，并随包分发 `onebot-ops`、`onebot-messaging` 技能。兼容 OpenClaw 2026.3+，Node.js >= 22。

**目录**：[安装](#安装) · [功能](#功能) · [智能触发](#智能触发smart-trigger) · [戳一戳回应](#戳一戳回应pokereply) · [引用链](#引用链quotechaindepth) · [引用机器人即回复](#引用机器人时立即回复quotetobotreply) · [@ 群成员](#-群成员atenabled) · [长消息处理](#长消息处理与-og-图片渲染) · [撤回消息](#撤回消息onebot_recall) · [Agent 技能](#agent-技能skills) · [测试](#测试)

## 安装

```bash
openclaw plugins install @kirigaya/openclaw-onebot
openclaw onebot setup
openclaw gateway restart
```

也可以使用 OpenClaw 原生的渠道配置命令（需要插件已安装）：

```bash
openclaw channels add --channel onebot --host 127.0.0.1 --port 3001
openclaw gateway restart
```

> 从 OpenClaw 2026.x 开始，外部插件必须显式启用后 Gateway 才会加载：
> `openclaw.json` 中需要存在 `plugins.entries.openclaw-onebot.enabled=true`。
> `openclaw onebot setup`、`openclaw channels add` 与 `openclaw plugins install` 都会自动写入该条目。

### 检查频道是否注册成功

```bash
openclaw channels list --all     # 应显示：OneBot default: installed, configured, enabled
openclaw channels status         # 应显示：OneBot default: enabled, configured
```

如果 `channels list` 只显示 `OneBot: installed, not configured, disabled`，或 Gateway 日志出现
`external plugin "openclaw-onebot" is installed without explicit trust`，执行：

```bash
openclaw plugins enable openclaw-onebot
openclaw gateway restart
```

手动通过 `plugins.load.paths` 加载本地插件目录时，同样需要这个 enabled 条目（`openclaw onebot setup` 会自动补上）。

## 教程

[让 QQ 接入 openclaw！让你的助手掌管千人大群](https://kirigaya.cn/blog/article?seq=368)

<img src="./figure/arch.png" />


## 功能

- ✅ 私聊：所有消息 AI 都会回复
- ✅ 群聊触发：@ 机器人、关键词触发、两段式智能触发（关键词/别名直通 + LLM 判定 + 成本护栏）
- ✅ 引用机器人即回复：群友直接引用机器人发言时立即回复（`quoteToBotReply`），多层引用链可一次性展开（`quoteChainDepth`）
- ✅ 戳一戳回应：被「戳一戳 / 拍一拍」时走完整对话流程（`pokeReply`，可回戳、带冷却）
- ✅ @ 群成员：`[[at:QQ号]]`（兼容 `[CQ:at,qq=QQ号]`），空/非法 QQ 号发送前剥除
- ✅ 自动获取上下文：群聊历史、昵称 + QQ 号、引用链、表情包库摘要
- ✅ 表情包：保存 / 发送 / 列出本地表情包库（`onebot_sticker_*`）
- ✅ 消息操作：发送图片（URL / 本地 / base64）、上传群文件、撤回自己发出的消息（`onebot_recall`）
- ✅ 自定义新成员入群欢迎触发器
- ✅ 长消息处理：超过阈值自动分段（`normal`）/ 渲染图片（`og_image`）/ 合并转发（`forward`）
- ✅ 支持黑白名单系统
- ✅ Agent 工具：注册 `onebot_*` 工具，并在插件清单声明 `contracts.tools`
- ✅ 随包技能：`onebot-ops`（运维/配置）、`onebot-messaging`（群聊互动语法）

## 安装 onebot 服务端

你需要安装 onebot 服务端，QQ 目前比较常用的是 onebot 服务端是 NapCat，可以查看 [官网](https://napneko.github.io/) 了解安装方法


### 连接类型

| 类型 | 说明 |
|------|------|
| `forward-websocket` | 插件主动连接 OneBot（go-cqhttp、Lagrange.Core 正向 WS/WSS） |
| `backward-websocket` | 插件作为服务端，OneBot 连接过来 |

> 💡 **提示**：支持 `ws://` 和 `wss://`（WebSocket Secure）协议，可填写完整 URL 如 `wss://ws-napcatqq.example.com`

### 环境变量

可替代配置文件，适用于 Lagrange 等：

| 变量 | 说明 |
|------|------|
| `ONEBOT_WS_TYPE` | forward-websocket / backward-websocket |
| `ONEBOT_WS_HOST` | 主机地址 |
| `ONEBOT_WS_PORT` | 端口 |
| `ONEBOT_WS_ACCESS_TOKEN` | 访问令牌 |

## 使用

1. 安装并配置
2. 重启 Gateway：`openclaw gateway restart`
3. 在 QQ 私聊或群聊中发消息（群聊需 @ 机器人，或配置关键字触发）

## 关键字触发回复

除了 @ 机器人外，还可以配置关键字检测，当群消息包含指定关键字时自动触发回复（无需 @）。
需要先把 `requireMention` 设为 `false`：

```json
{
  "channels": {
    "onebot": {
      "requireMention": false,
      "triggerKeywords": ["AI", "助手", "帮我问"],
      "triggerMode": "prefix"
    }
  }
}
```

| 配置项 | 说明 |
|--------|------|
| `requireMention` | 群聊是否必须 @ 机器人才回复；设为 `false` 后按关键字触发 |
| `triggerKeywords` | 关键字列表，包含任一关键字即触发 |
| `triggerMode` | `prefix`（以关键字开头，默认）或 `contains`（包含即触发） |

## 智能触发（smart trigger）

群聊里不是每条消息都值得机器人接话。智能触发（`channels.onebot.smartTrigger`）把非 @ 的群消息拆成**两段**判断：第一段零成本直通，第二段才调用宿主 LLM 做「是否值得接话」的判定，从而在「群友觉得机器人存在感强」和「token 账单不爆炸」之间取平衡。

### 两段式流程

```
群消息（未 @ 机器人）
  │
  ├─ 第一段：零 token 直通
  │    ├─ 消息命中 keywords（为空时继承 triggerKeywords）→ 放行
  │    ├─ 消息包含 aliases（机器人别名/昵称）→ 放行
  │    └─ 未命中 → 进入第二段
  │
  ├─ 第二段：LLM 判定（消耗 token）
  │    ├─ 成本护栏：同群判定最小间隔 / 回复冷却 / 每小时上限
  │    │    └─ 任一项超限 → 跳过，只记历史，不调用 LLM
  │    ├─ 过短消息（< minMessageChars，纯表情/符号）→ 跳过
  │    └─ 调用宿主 LLM，返回 {reply, confidence, intent, reason}
  │         ├─ reply=true 且 confidence ≥ threshold → 放行
  │         └─ 否则 → 忽略，只记历史
  │
  └─ 放行后走原有 dispatch 流程，正常生成并发送回复
```

补充规则：

- **@ 机器人始终直接放行**，不经过智能触发判定。
- 被跳过或忽略的消息仍会写入群聊历史（`rememberMessage`），下一次判定时作为上下文参与，不会丢上下文。
- `smartTrigger` **默认关闭**，必须显式配置 `enabled: true` 才生效（即使 `requireMention: true` 也不会默认开启）；关闭时行为与旧版本完全一致。

### 配置示例

编辑 `~/.openclaw/openclaw.json`，在 `channels.onebot` 下添加 `smartTrigger`：

```json
{
  "channels": {
    "onebot": {
      "type": "forward-websocket",
      "host": "127.0.0.1",
      "port": 3001,
      "requireMention": true,
      "smartTrigger": {
        "enabled": true,
        "groups": [1046693162, 782833642],
        "keywords": ["AI", "助手", "帮我问"],
        "keywordMode": "contains",
        "aliases": ["小助手", "小助手酱"],
        "threshold": 0.6,
        "timeoutMs": 8000,
        "minIntervalMs": 3000,
        "cooldownMs": 30000,
        "maxRepliesPerHour": 6,
        "historyLimit": 10,
        "maxInputChars": 2000,
        "model": "",
        "fallback": "ignore",
        "minMessageChars": 2,
        "allowModelSilence": false,
        "silentMarker": "[[silent]]"
      }
    }
  }
}
```

> 示例中的 `host` / `port` / 群号请按自己的环境填写；`accessToken` 等凭据请勿写进文档或提交到仓库。

### 字段说明

| 字段 | 类型 | 默认 | 范围 | 说明 |
|------|------|------|------|------|
| `enabled` | boolean | `false` | - | 总开关，必须显式设为 `true` 才生效 |
| `groups` | number[] | `[]` | - | 只对这些群号生效；空数组 = 全部群 |
| `keywords` | string[] | `[]` | - | 直通关键词，命中即放行、不消耗 LLM；为空时继承 `triggerKeywords` |
| `keywordMode` | `prefix` \| `contains` | `contains` | - | 关键词匹配模式（智能触发默认 `contains`，与全局 `triggerMode` 的 `prefix` 默认值不同） |
| `aliases` | string[] | `[]` | - | 机器人别名（QQ 昵称等），消息包含任一别名即直通 |
| `threshold` | number | `0.6` | 0~1 | LLM 置信度阈值，`confidence ≥ threshold` 才放行 |
| `timeoutMs` | number | `8000` | 1000~60000 | 单次 LLM 判定超时，超时按 `fallback` 处理 |
| `minIntervalMs` | number | `3000` | 0~600000 | 同群两次 LLM 判定的最小间隔 |
| `cooldownMs` | number | `30000` | 0~3600000 | 放行回复后同群的冷却时间 |
| `maxRepliesPerHour` | number | `6` | 0~100（0=不限） | 同群每小时最多放行次数 |
| `historyLimit` | number | `10` | 0~30 | 喂给判定模型的最近消息条数 |
| `maxInputChars` | number | `2000` | 200~8000 | 判定输入（历史 + 当前消息）字符上限，超出从最旧的部分截断 |
| `model` | string | `""` | - | 可选，覆盖判定模型（如 `deepseek/deepseek-flash`）；空 = 宿主 agent 默认模型 |
| `fallback` | `ignore` \| `reply` | `ignore` | - | LLM 不可用 / 超时 / 解析失败时的策略 |
| `minMessageChars` | number | `2` | 0~200 | 过短消息（纯表情/符号）不判定，直接忽略 |
| `allowModelSilence` | boolean | `false` | - | 放行后在 prompt 中允许模型输出 `silentMarker` 自主沉默 |
| `silentMarker` | string | `[[silent]]` | - | 沉默标记 |
| `sassEnabled` | boolean | `true` | - | 允许判定器在轻松场合选择吐槽式接话（`intent=sass`）；关闭后只会认真回答 |
| `sassStyle` | string | `""` | - | 自定义吐槽风格提示，仅对 `intent=sass` 的放行生效；空 = 内置默认文案 |
| `judgePersona` | string | `""` | - | 判定器使用的人设摘要（「这是谁、别人怎么叫它」）；空 = 内置默认（小鲸鱼）。见下文「让判定器按人设判断」 |

所有数值都会被 clamp 到上表范围；类型非法的值回落默认值，不会抛错。字段含义与默认值以 `openclaw.plugin.json` 中的 schema 为准。

### 成本护栏

第二段判定会真实消耗 token，因此同一群维度上有三道护栏，任一超限都**直接跳过**（不调用 LLM，只记历史）：

| 护栏 | 字段 | 默认 | 作用 |
|------|------|------|------|
| 判定最小间隔 | `minIntervalMs` | 3000 | 同群两次判定之间至少间隔 3 秒，避免连刷时反复调用模型 |
| 回复冷却 | `cooldownMs` | 30000 | 机器人刚在群里说过话后，30 秒内不再接话 |
| 每小时上限 | `maxRepliesPerHour` | 6 | 同群每小时最多放行 6 次，`0` 表示不限 |

另外还有两个零成本护栏：`keywords` / `aliases` 命中在第一段就放行（不消耗 token）；`minMessageChars` 把「6」「哈哈哈」「😂」这类过短消息直接挡在判定之外。`historyLimit` 与 `maxInputChars` 则控制了单次判定的输入规模，避免历史越长越贵。

### LLM 判定用的模型

判定统一走宿主提供的 `api.runtime.llm.complete`，插件本身**不读取任何 provider key、也不直接依赖模型 SDK**：

- `smartTrigger.model` 为空（默认）时，使用宿主 agent 配置的默认模型；
- 想用更便宜的小模型做判定时，填 `smartTrigger.model`，但必须在宿主的插件配置里显式允许覆盖：

```json
{
  "plugins": {
    "entries": {
      "openclaw-onebot": {
        "enabled": true,
        "llm": { "allowModelOverride": true }
      }
    }
  }
}
```

未开启 `plugins.entries.openclaw-onebot.llm.allowModelOverride=true` 时，请求会被宿主拒绝，判定将走 `fallback` 策略。

判定请求的参数是固定的：`purpose: "onebot.smart-trigger"`、`maxTokens: 256`、`temperature: 0`，并要求模型只输出 JSON `{"reply": bool, "confidence": 0~1, "intent": "answer|sass", "reason": "..."}`（`sassEnabled: false` 时输出不含 `intent`）。宿主不支持 LLM（`api.runtime.llm.complete` 不存在）时会立即走 `fallback`。

### `allowModelSilence`（放行后的自主沉默）

`fallback: "reply"` 或判定放行之后，模型拿到上下文仍可能觉得「此刻不该说话」。`allowModelSilence: true` 会在 prompt 里追加一句约定：

> 如果你判断此刻不适合接话，只输出 `silentMarker`，不要输出任何其他内容。

插件在投递阶段识别到回复内容等于 `silentMarker`（默认 `[[silent]]`）时，**不发任何消息**，标记本身也不会出现在群里。适合用 `fallback: "reply"` 兜底、又不想在噪音消息上强行发言的场景。

### 让判定器按人设判断（judgePersona）

判定器默认**看不到**主模型的人设文件（IDENTITY / SOUL），它只知道「群里有个机器人」，不知道「这是谁、别人怎么叫它」。典型误判由此而来：群里 A @ B 说话，判定器把两人互动当成「群友玩闹素材」，给出 `intent=sass` 放行，机器人就插进别人的对话里吐槽。

`smartTrigger.judgePersona` 用来补上这块信息：一段简短人设摘要，作为 system prompt 的「【机器人是谁】」注入。空字符串时使用内置默认（小鲸鱼）。

判定器同时还会收到结构化的「对象」信息：

- user prompt 的 `【本条消息 @ 了】` 会逐个标注 @ 目标是「机器人自己」还是「其他群友」；
- system prompt 的补充判断要求：消息在跟其他群友说话（@了别人、或明显两人互动）时 `reply=false`；只有 @ 机器人、引用机器人的消息、或提到它的名字/昵称才算在叫它。

```json
"smartTrigger": {
  "judgePersona": "一只叫「小鲸鱼」的 QQ 群聊机器人，网友也叫它「大肥鱼」「鲸鱼娘」「鲸宝」，QQ 昵称是「辉の大肥鱼」——别人这么叫就是在叫它。性格傲娇嘴硬、话短、懒得营业，正事上靠谱；不是客服、不是助手、也不是气氛组。"
}
```

这是提示词层的约束，不是硬跳过：判定器仍然会看到 @ 别人的消息，只是按人设应该判 `reply=false`。插件有意不提供「@别人就直接丢弃」的硬开关——那会误杀「有人在 @ 别人的同时其实在说机器人」的情况。

### 吐槽式接话（sass）

`smartTrigger.sassEnabled`（默认 `true`）让判定器除了判断「要不要接话」，还判断「用哪种方式接」：

- `intent=answer`：认真回答 / 帮忙（提问、求助、延续机器人话题）；
- `intent=sass`：吐槽 / 接梗。判定器在轻松氛围下识别可吐槽素材：群友自嘲、吹牛立 flag、离谱翻车、抽象整活、玩梗求接梗、阴阳怪气但不伤人，`confidence` 给 0.65~0.85；
- 群友争吵、人身攻击、隐私/敏感话题，或吐槽可能冒犯当事人时仍然 `reply=false`。

判定为 `sass` 且放行后，插件会在给主模型的上下文里注入一段风格提示（不会发到群里）：

> 【接话风格】这条消息适合吐槽接梗：用 1~2 句短句犀利吐槽或接梗，可以损但不要脏话、不要人身攻击、不要说教、不要长篇大论；拿不准就不必勉强。

想换个吐槽风格（例如更阴阳怪气、更简短、带口头禅），把 `smartTrigger.sassStyle` 设成自己的提示文案即可，它会完全替换上面的默认文案。

调参建议：

| 现象 | 调整 |
|---|---|
| 该吐槽时只会正经回答 | 提高判定器对吐槽的偏好：把 `threshold` 降到 `0.55`，或把 `sassStyle` 写成更强的风格约束 |
| 吐槽太频繁 / 太冲 | 提高 `threshold`、降低 `maxRepliesPerHour`、增大 `cooldownMs`；或只把 `sassEnabled` 关掉 |
| 总在不该接话时接话 | 提高 `threshold`（0.7 左右）、增大 `minIntervalMs` |

开启 `allowModelSilence` 时，模型即使被放行也可以输出 `silentMarker`（默认 `[[silent]]`）表示「这条不适合吐槽」，不会发出任何消息。

如果机器人有人设，把 `sassStyle` 写成符合人设的一句话会自然很多。示例（本项目线上「小鲸鱼」人设，傲娇嘴硬、话短）：

```json
"smartTrigger": {
  "sassEnabled": true,
  "sassStyle": "【接话风格】这条适合吐槽接梗：照小鲸鱼的傲娇路子，一句，10 字内；嘴硬带点损、不刻薄，不脏话、不解释、不客服腔、不写括号；别自称大肥鱼。"
}
```

### 开启步骤

1. 编辑 `~/.openclaw/openclaw.json`，在 `channels.onebot` 下加入上述 `smartTrigger` 配置块，确认 `enabled: true`。
2. 如需覆盖判定模型，同时在 `plugins.entries.openclaw-onebot.llm.allowModelOverride` 设为 `true`。
3. 重启 openclaw-gateway（`openclaw gateway restart`；systemd 环境为 `systemctl restart openclaw-gateway`）。
4. 在配置的群里发一条「不 @ 机器人」的消息验证：日志中出现 `[onebot][smart] group=<群号> decision=...`，说明判定生效。

日志固定前缀为 `[onebot][smart]`，可据此排查：`decision=reply`（放行）、`decision=ignore`（判定不接话）、`decision=skip reason=min-interval|cooldown|hourly-limit|too-short|in-flight`（被护栏挡下；`in-flight` 表示同群上一条消息还在判定中，并发消息不会重复调用 LLM）、`decision=fallback`（LLM 失败）。

## 戳一戳回应（pokeReply）

QQ 的「戳一戳 / 拍一拍」在 OneBot v11 里是 notice 事件（`notice_type: "notify"` + `sub_type: "poke"`，或 `notice_type: "poke"`）。开启后，别人戳机器人时，插件会构造一条内部消息走**完整的 LLM 回复管线**（带人设、带群聊上下文），由模型决定说什么，而不是固定文案。

```json
{
  "channels": {
    "onebot": {
      "pokeReply": {
        "enabled": true,
        "cooldownMs": 10000,
        "pokeBack": false,
        "prompt": "（戳了戳你）"
      }
    }
  }
}
```

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `enabled` | boolean | `false` | 总开关，必须显式开启 |
| `cooldownMs` | number | `10000` | 同群/同人冷却，防连戳刷屏；`0` 表示不去重 |
| `pokeBack` | boolean | `false` | 是否先回戳一下（`group_poke` / `friend_poke`），失败不影响 LLM 回应 |
| `prompt` | string | `（戳了戳你）` | 注入给模型的场景文本 |

行为说明：

- 只处理「戳的是机器人自己」的事件（`target_id === self_id`），戳别人不回应；
- 回应走正常回复管线：人设、群聊历史、引用、长消息分块、`[[silent]]`（若开启）都生效；
- 合成消息不写 `message_id`，因此不会发「思考表情」反应，也不会产生可引用的假消息 ID；
- 日志前缀 `[onebot][poke]`：`decision=reply source=llm`（已转交模型）、`skip reason=cooldown remain=Ns`（冷却跳过）。

## 引用链（quoteChainDepth）

QQ 里可以「引用一条引用了另一条的消息」：消息 3 引用 2、2 引用 1。插件会沿 `reply` 段一路上溯，把整条链**一次性**拼进上下文：

```json
"channels": {
  "onebot": {
    "quoteChainDepth": 3
  }
}
```

| 值 | 行为 |
|---|---|
| `3`（默认） | 最多往上取 3 层，一次带全 |
| `0` | 只取直接引用的那一条（不再向上追溯，与旧版行为一致） |
| 上限 `10` | 防止超长链拖慢判定、撑爆上下文 |

模型实际看到的是：

```
[引用链（由旧到新，共 2 条）]
1. [#101] 李四：又蓝屏了
2. [#102] 阿三：换台机器吧
这破电脑到底怎么了
```

实现见 `src/quote-chain.ts`：`buildQuoteChain` 依赖注入 `get_msg`（便于单测），`formatQuoteChain` 负责格式化。单层时仍输出 `[引用 X 的消息：...]`，多层才用序号列表；自带防环（自引用 / 互相引用）、单条 300 字截断、整链 1200 字预算（超预算时优先保留靠近当前的那几条）。引用链全文也会作为 `quotedText` 交给智能触发判定器，避免「追问了三层，判定器只看到最后一层」。

### 引用机器人时立即回复（quoteToBotReply）

群友**直接引用机器人自己发的那条消息**时，插件会立即触发回复，效果等同 @：跳过智能触发的关键词 / 别名直通与 LLM 判定。这是默认行为，`quoteToBotReply` 默认 `true`。

- 与 `smartTrigger.enabled` **无关**——智能触发关着也生效；`requireMention: true` 时同样生效；
- 只认「**直接引用的那一条**」的发送者：消息 3 引用 2、2 引用 1 时，只有 2 是机器人发的才算（`src/quote-chain.ts` 的 `quoteTargetIsSelf` 判断链尾 `senderId === selfId`）；
- 因为是对机器人的明确回应，该路径不注入 `allowModelSilence` 的「可以不接话」提示；
- 不生效的情况：发送者在黑名单内；引用消息取不到（`get_msg` 失败 / 已被撤回）；
- 关闭方式：

```json
{ "channels": { "onebot": { "quoteToBotReply": false } } }
```

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `quoteToBotReply` | boolean | `true` | 群友直接引用机器人发言时立即回复（等同 @，跳过智能触发判定）；显式 `false` 关闭 |

排查日志：命中引用机器人时出现 `[onebot] quote-chain replyId=... len=N ids=... to=self`（带 `to=self`），随后 `[onebot][smart] group=... decision=reply source=quote-to-bot replyId=... intent=answer`。

## @ 群成员（atEnabled）

模型可以在回复里 @ 群成员。推荐写法是标记 `[[at:QQ号]]`，插件会在发送前把它转成 OneBot 的 `at` 消息段；也兼容模型直接输出 CQ 码 `[CQ:at,qq=QQ号]`。

- QQ 号来源：上下文里每行消息前的 `昵称(qq: 数字)`，或历史消息文本里的 `@数字`（被 @ 的人）；
- 空 QQ 号（`[CQ:at,qq=]`）、过短/非法 QQ 号会被直接剥除，**不会把 CQ 码字面发到群里**；
- `atEnabled: false` 时，回复里的 at 标记会被移除，只发文本（用于不想让模型 @ 人的场景）。

配置（默认开启）：

```json
{ "channels": { "onebot": { "atEnabled": true } } }
```

> 模型有时会自己写 CQ 码，插件已经兼容；但更稳的是提示模型用 `[[at:QQ号]]`。历史上出现过 `[CQ:at,qq=]` 空号被当文本发到群里的情况，本版本已在发送前统一兜底。

## 长消息处理与 OG 图片渲染

当单次回复超过**长消息阈值**（默认 300 字）时，可选用三种模式（`openclaw onebot setup` 中配置）：

| 模式 | 说明 |
|------|------|
| `normal` | 准流式分段发送：边生成边聚合，按时间窗口或长度阈值增量发送 |
| `og_image` | 将 Markdown 转为 HTML 再生成图片发送（需安装 `satori` 和 `sharp`） |
| `forward` | 合并转发（发给自己后打包转发） |

`normal` 模式默认会开启块流式接收，并在插件侧做短时间聚合，默认规则：

- `normalModeFlushIntervalMs`: `1200`
- `normalModeFlushChars`: `160`

也就是回复不会逐 token 刷屏，而是大约每 1.2 秒或累计到 160 字左右就发送一段。可在 `openclaw.json` 中手动调整：

```json
{
  "channels": {
    "onebot": {
      "longMessageMode": "normal",
      "normalModeFlushIntervalMs": 1200,
      "normalModeFlushChars": 160
    }
  }
}
```

选择 **生成图片发送（og_image）** 时，会额外询问**渲染主题**：

| 选项 | 说明 |
|------|------|
| **default** | 无额外样式，默认白底黑字 |
| **dust** | 内置主题：暖色、旧纸质感 |
| **custom** | 自定义：在 `ogImageRenderThemePath` 中填写 CSS 文件绝对路径 |

配置项（枚举 + 可选路径）：

- `ogImageRenderTheme`：`"default"` | `"dust"` | `"custom"`
- `ogImageRenderThemePath`：当为 `custom` 时必填，CSS 文件绝对路径

示例（`openclaw.json`）：

```json
{
  "channels": {
    "onebot": {
      "longMessageMode": "og_image",
      "longMessageThreshold": 300,
      "ogImageRenderTheme": "dust"
    }
  }
}
```

自定义主题示例：

```json
{
  "channels": {
    "onebot": {
      "longMessageMode": "og_image",
      "ogImageRenderTheme": "custom",
      "ogImageRenderThemePath": "C:/path/to/your-theme.css"
    }
  }
}
```

## 主动发送消息

通过 `openclaw message send` CLI（无需 Agent 工具）：

```bash
# 发送文本
openclaw message send --channel onebot --target user:123456789 --message "你好"

# 发送图片
openclaw message send --channel onebot --target group:987654321 --media "file:///path/to/image.png"
```

`--target` 格式：`user:QQ号` 或 `group:群号`。回复场景由 deliver 自动投递，Agent 输出 text/mediaUrl 即会送达。

## 撤回消息（onebot_recall）

Agent 工具 `onebot_recall` 用来撤回机器人自己发出的消息：

| 参数 | 说明 |
|---|---|
| `target` | `group:群号` / `user:QQ号`；不传 `messageId` 时用它定位「最近一条」 |
| `messageId` | 可选，`onebot_send_text` / `onebot_send_image` / `onebot_sticker_send` 成功时会返回 |

- 普通回复（deliver）与所有发送工具都会记录「该会话最近一条消息 ID」（`src/recall.ts`），所以不传 ID 也能撤回刚说错的那句
- QQ 通常只允许撤回 **2 分钟内**的消息，且只能撤自己的
- 底层走 OneBot `delete_msg`，失败会返回具体原因（超时 / 无权限 / ID 不存在）

## 新成员入群欢迎（自定义图片）

当有新成员加入群时，可根据其 ID 信息生成欢迎图片并发送。详见 [receive.md](skills/onebot-ops/receive.md#新成员入群欢迎)。

1. 在 `openclaw.json` 中配置：

```json
{
  "channels": {
    "onebot": {
      "groupIncrease": {
        "enabled": true,
        "command": "npx tsx src/openclaw/trigger/welcome.ts",
        "cwd": "C:/path/to/Tiphareth"
      }
    }
  }
}
```

2. `command` 在 `cwd` 下用系统 shell 执行，环境变量传入 `GROUP_ID`、`GROUP_NAME`、`USER_ID`、`USER_NAME`、`AVATAR_URL`。命令可调用 `openclaw message send` 自行发送，或向 stdout 输出 JSON 行供 handler 发送。

3. 测试：`npm run test:group-increase-handler`（DRY_RUN 模式，仅生成图片）

## 回复白名单

默认为空回复所有人的消息。如果设置的话，那么机器人就只会回复设置的数组里的用户的消息。

```json
{
  "channels": {
    "onebot": {
      "whitelistUserIds": [1193466151]
    }
  }
}
```

## 黑名单

在群里有时候有些人需要被屏蔽，不管他怎么 @ 还是怎么，都屏蔽他的消息不触发。

```json
{
  "channels": {
    "onebot": {
      "blacklistUserIds": [123456789]
    }
  }
}
```

**注意**：白名单优先级高于黑名单。如果同时设置了白名单和黑名单，只有白名单内的用户才能触发，且黑名单内的白名单用户也会被屏蔽。

## 新人入群触发器

如果有人入群之后，可以通过这个来实现触发器。

```json
{
  "channels": {
    "onebot": {
      "groupIncrease": {
        "enabled": true,
        "command": "npx tsx welcome.ts",
        "cwd": "/path/to/triggers"
      }
    }
  }
}
```

实现的脚本必须支持这三个参数：

```
--userId ${userId} --username ${username} --groupId ${groupId}
```

## Agent 技能（skills）

插件随包提供两个 skill，告诉 agent 在 QQ 里怎么说话、怎么用原生能力：

| Skill | 内容 |
|---|---|
| `onebot-messaging` | 引用（`[[quote:ID]]`）、@ 群友（`[[at:QQ号]]`）、表情包（`onebot_sticker_*`）、发图片、戳一戳机制（只有被动）、群文件/历史/搜人、常见错误 |
| `onebot-ops` | 渠道运维：安装、配置、收发消息、CLI 用法 |

**注意**：OpenClaw 2026.10.x 不会扫描插件包内的 `skills/` 目录。要让 agent 真正看到，需要把 skill 复制到 agent 目录：

```bash
mkdir -p ~/.openclaw/agents/<agentId>/agent/workshop-skills/onebot-messaging
cp skills/onebot-messaging/SKILL.md ~/.openclaw/agents/<agentId>/agent/workshop-skills/onebot-messaging/SKILL.md
openclaw skills info onebot-messaging   # 应显示 Ready / Visible to model: yes
```

不需要重启网关，下一轮对话即生效。

## 测试

### 测试连接

项目内提供测试脚本（需 `.env` 或环境变量）：

```bash
cd openclaw-onebot
npm run test:connect
```

### 测试 OG 图片渲染效果

用于预览「Markdown 转图片」在不同主题下的渲染效果（需安装 `satori` 和 `sharp`）：

```bash
cd openclaw-onebot
# 无额外样式
npm run test:render-og-image -- default
# 内置 dust 主题
npm run test:render-og-image -- dust
# 自定义 CSS 文件（绝对路径）
npm run test:render-og-image -- "C:/path/to/your-theme.css"
```

生成图片保存在 `test/output-render-<主题>.png`，可直接打开查看。

## 参考

- [OneBot 11](https://github.com/botuniverse/onebot-11)
- [go-cqhttp](https://docs.go-cqhttp.org/)
- [Lagrange.Core](https://github.com/LSTM-Kirigaya/Lagrange.Core)
- [NapCat](https://github.com/NapNeko/NapCatQQ)

## 联系

zhelonghuang@qq.com

要是我不回你，可以选择进我的QQ群。782833642

## License

MIT © [LSTM-Kirigaya](https://github.com/LSTM-Kirigaya)
