# 变更日志

本项目的所有重要变更都记录在此文件。

格式遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.3.0] - 2026-10-28

### 新增

- **群聊智能触发**（`channels.onebot.smartTrigger`）：两段式判定——消息命中关键词 / 机器人别名时零 token 直通；未命中时调用宿主 `api.runtime.llm.complete` 判断「是否值得接话」，`reply=true` 且 `confidence ≥ threshold` 才放行。默认关闭，必须显式 `enabled: true` 才生效。
- **智能触发成本护栏**：同群判定最小间隔（`minIntervalMs`）、回复冷却（`cooldownMs`）、每小时放行上限（`maxRepliesPerHour`），另有 `minMessageChars` 过滤纯表情与过短消息；超限直接跳过并只记历史。`historyLimit` / `maxInputChars` 控制单次判定的输入规模。
- **判定人设与吐槽风格**：`judgePersona` 给判定器补充人设摘要（配合「本条消息 @ 了」「机器人自己的 QQ」等提示，避免把 A @ B 或同名群友当成机器人）；`sassEnabled` / `sassStyle` 在轻松场合返回 `intent=sass` 并注入吐槽风格提示。
- **引用链展开**（`quoteChainDepth`，默认 3）：消息 3 引用 2、2 引用 1 时一次性把整条引用链拼进上下文；带防环、单条 300 字截断、整链 1200 字预算。
- **引用机器人时立即回复**（`quoteToBotReply`，默认开启）：群友直接引用机器人自己发的消息时立即回复，等同 @，跳过智能触发判定；与 `smartTrigger.enabled` 无关，`requireMention: true` 时同样生效。
- **@ 群成员**（`atEnabled`，默认开启）：支持 `[[at:QQ号]]` 与 `[CQ:at,qq=QQ号]`，空/非法 QQ 号在发送前剥除，不会把 CQ 码字面发到群里。
- **戳一戳回应**（`pokeReply`）：响应「戳一戳 / 拍一拍」事件，构造内部消息走完整 LLM 回复管线，支持同群/同人冷却与可选回戳。
- **表情包工具**：`onebot_sticker_save` / `onebot_sticker_send` / `onebot_sticker_list`，支持本地表情包库的收录、发送与查看。
- **撤回消息**：`onebot_recall` 撤回机器人自己发出的消息；不传 ID 时撤回该会话最近一条。
- **发送图片**：`onebot_send_image` 支持 URL、本地路径与 `base64://` 三种来源。
- **Agent 工具注册**：`openclaw.plugin.json` 声明 `contracts.tools` 并与 `src/tools.ts` 中注册的 `onebot_*` 工具保持同步（OpenClaw 2026.10+ 必须声明后才能注册工具）。
- **技能分发**：新增 `onebot-messaging` 技能（引用 / @ / 表情包 / 图片 / 戳一戳 / 工具速查）；`openclaw.skills` 声明修正为实际目录 `skills/onebot-ops`、`skills/onebot-messaging`。
- **红队注入测试**：新增 `test/redteam-injection/` 用例与检测器，可用 `npm run redteam:injection`、`npm run redteam:selfcheck` 运行。

### 变更

- `package.json` 版本号 1.2.1 → 1.3.0；`files` 增加 `CHANGELOG.md`，`.npmignore` 与 `files` 白名单对齐。
- 新增 `test:smart-trigger` 测试脚本，覆盖智能触发（含集成）、戳一戳、@、撤回与引用链。
- README 补充智能触发、成本护栏、引用链、引用机器人即回复、@ 群成员、戳一戳、撤回与技能分发等章节。

### 修复

- 智能触发：数值配置统一 clamp 到合法范围，非法类型回落默认值，解析过程永不抛错。
- 引用链：`get_msg` 失败或消息已撤回时退化为直接引用，不中断消息处理。
- 消息发送：`normal` 模式下短回复的缓冲与分块稳定性修补。

## [1.2.1] - 2026-10-27

### 变更

- 消息发送链（LLM → OneBot 下发）与 `normal` 模式短回复缓冲的稳定性修补（占位条目：该版本未单独发布说明）。

## [1.2.0] - 2026-05-08

### 新增

- 支持通道 binding。
- 通过 OneBot API 解析发送者昵称，群聊上下文标签附带 QQ 号。

### 修复

- 修复 `normal` 模式短回复因缺少 final 帧导致缓冲区未及时发送的问题。

---

更早版本（1.1.x 及以前）见 Git 提交历史与 GitHub Releases。
