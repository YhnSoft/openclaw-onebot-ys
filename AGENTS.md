# OpenClaw OneBot 插件开发指南

## 项目概述

OpenClaw OneBot 是一个 OneBot v11 协议渠道插件，用于将 QQ（通过 Lagrange.Core/go-cqhttp/NapCat 等）接入 OpenClaw Gateway。

## 技术栈

- **语言**: TypeScript
- **运行时**: Node.js >= 22
- **构建工具**: TypeScript Compiler (tsc)
- **包管理器**: npm

## 核心依赖

```json
{
  "dependencies": {
    "@clack/prompts": "^1.0.0",
    "cron": "^4.4.0",
    "fuse.js": "^7.1.0",
    "highlight.js": "^11.10.0",
    "marked": "^15.0.0",
    "tsx": "^4.0.0",
    "ws": "^8.17.0"
  },
  "optionalDependencies": {
    "satori": "^0.12.0",
    "sharp": "^0.33.0"
  }
}
```

## 项目结构

```
openclaw-onebot/
├── src/                    # 源代码
│   ├── index.ts           # 插件入口
│   ├── channel.ts         # OneBot 渠道实现
│   ├── connection.ts      # WebSocket 连接管理
│   ├── og-image.ts        # Markdown 转图片（satori）
│   ├── smart-trigger.ts   # 智能触发：关键词/别名直通 + LLM 接话判定与成本护栏
│   ├── handlers/          # 消息处理器
│   │   ├── process-inbound.ts  # 入站编排：解析 → 触发 → 权限 → dispatch → 发送管线
│   │   ├── inbound-parse.ts    # 引用链、引用机器人、媒体附件、昵称解析
│   │   ├── inbound-trigger.ts  # 群聊触发决策（@ / 引用机器人 / 智能触发 / 关键词）
│   │   ├── inbound-prompt.ts   # 模型 Body 与 ctxPayload 构建
│   │   ├── inbound-forward.ts  # forward 模式待处理会话与清理
│   │   ├── poke.ts             # 戳一戳回应
│   │   └── group-increase.ts   # 入群欢迎
│   └── ...
├── dist/                  # 编译输出（.js）
├── test/                  # 单元 / 集成测试（node:test + tsx）
│   └── ...
├── skills/                # OpenClaw 技能（onebot-ops / onebot-messaging）
├── themes/                # 主题文件
├── scripts/               # 工具脚本
├── CHANGELOG.md
├── package.json
├── tsconfig.json
└── openclaw.plugin.json   # 插件配置
```

核心文件职责：

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 插件入口，注册渠道、服务、CLI 与 Agent 工具 |
| `src/channel.ts` | OneBot 渠道实现（收发、deliver 投递） |
| `src/connection.ts` | OneBot WebSocket 连接管理与 API 调用 |
| `src/config.ts` | 配置解析（含 `getSmartTriggerConfig`，负责 clamp 与默认值） |
| `src/smart-trigger.ts` | 智能触发：直通匹配、成本护栏状态、判定 prompt、`api.runtime.llm.complete` 调用与结果解析 |
| `src/handlers/process-inbound.ts` | 入站编排：解析消息 → 触发判定 → 白/黑名单 → 拼 prompt → dispatch → 发送管线 |
| `src/handlers/inbound-parse.ts` | 引用链展开、引用机器人判定、视频/GIF 收集、发送者昵称解析 |
| `src/handlers/inbound-trigger.ts` | 群聊触发决策：@ / 引用机器人 / 智能触发两段式 / requireMention / triggerKeywords |
| `src/handlers/inbound-prompt.ts` | 构建模型 Body（历史 + 引用/表情包/沉默/吐槽/@ 提示）与 ctxPayload |
| `src/handlers/inbound-forward.ts` | forward 模式待处理会话状态与定期清理 |
| `src/og-image.ts` | Markdown 转图片（satori + sharp） |
| `openclaw.plugin.json` | 插件清单与渠道配置 schema（含 `smartTrigger` 字段与 uiHints） |

## 开发工作流

### 1. 安装依赖

```bash
npm install
```

### 2. 开发模式

修改 TypeScript 源代码后需要重新编译：

```bash
npm run build
```

### 3. 测试图片生成功能

```bash
# 测试默认主题
npx tsx test/render-og-image.ts default

# 测试 dust 主题
npx tsx test/render-og-image.ts dust

# 输出位置
# test/output-render-default.png
```

### 4. 重启 OpenClaw 服务

```bash
# 停止服务
launchctl stop ai.openclaw.gateway

# 启动服务
launchctl start ai.openclaw.gateway

# 查看状态
openclaw status
```

### 5. 查看日志

```bash
# Gateway 日志
tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log

# LaunchAgent 日志
tail -f /Users/kirigaya/.openclaw/logs/gateway.log
```

## 配置说明

### OpenClaw 配置

配置文件位置: `~/.openclaw/openclaw.json`

关键配置项：

```json
{
  "channels": {
    "onebot": {
      "type": "forward-websocket",
      "host": "192.168.10.1",
      "port": 3001,
      "accessToken": "your-token",
      "enabled": true,
      "requireMention": true,        // 是否需要 @ 才响应
      "renderMarkdownToPlain": true,
      "longMessageMode": "og_image", // normal | og_image | forward
      "ogImageRenderTheme": "dust",  // 图片主题
      "longMessageThreshold": 300    // 超过此字符数转图片
    }
  },
  "plugins": {
    "load": {
      "paths": [
        "/Users/kirigaya/project/qqbot/openclaw-onebot"
      ]
    },
    "entries": {
      "openclaw-onebot": { "enabled": true }
    }
  }
}
```

> OpenClaw 2026.x 起，外部插件只有在 `plugins.entries.<plugin-id>.enabled=true`（或位于 `plugins.allow`）时
> Gateway 才会真正加载；否则只会发现插件并警告 “installed without explicit trust”。
> `openclaw onebot setup` 与 `openclaw channels add` 会自动写入该条目。

### 长消息处理模式

| 模式 | 说明 |
|------|------|
| `normal` | 正常分段发送 |
| `og_image` | 生成图片发送（需 satori + sharp） |
| `forward` | 合并转发消息 |

### 智能触发（smartTrigger）

`channels.onebot.smartTrigger` 是群聊「两段式」触发开关，**默认关闭**（`enabled` 默认 `false`，即使 `requireMention=true` 也不会自动开启）：

1. **第一段（零 token）**：非 @ 群消息命中 `keywords`（为空时继承 `triggerKeywords`）或 `aliases`（机器人别名）→ 直接放行，走原有 dispatch；@ 机器人始终直接放行。
2. **第二段（LLM）**：未命中时先过成本护栏（`minIntervalMs` / `cooldownMs` / `maxRepliesPerHour`，超限跳过且只记历史），再调用宿主 `api.runtime.llm.complete` 判断是否接话；`reply=true` 且 `confidence ≥ threshold` 才放行，否则只记历史（`rememberMessage`）后忽略。

实现分工：`src/config.ts` 的 `getSmartTriggerConfig` 负责解析与 clamp，`src/smart-trigger.ts` 负责直通匹配、护栏状态、提示词构造与 LLM 调用/解析，接入点是 `src/handlers/inbound-trigger.ts` 的 `decideGroupTrigger`（由 `process-inbound.ts` 调用）。

```json
{
  "channels": {
    "onebot": {
      "smartTrigger": {
        "enabled": true,
        "groups": [],
        "keywords": [],
        "threshold": 0.6,
        "cooldownMs": 30000,
        "maxRepliesPerHour": 6,
        "fallback": "ignore"
      }
    }
  }
}
```

判定默认使用宿主 agent 配置的模型；`smartTrigger.model` 可覆盖，但需宿主允许：`plugins.entries.openclaw-onebot.llm.allowModelOverride=true`。`allowModelSilence` 为 `true` 时，放行后的 prompt 允许模型只输出 `silentMarker`（默认 `[[silent]]`）表示自主沉默，该标记不会发送到群里。`sassEnabled`（默认 `true`）让判定器在轻松场合（自嘲、吹牛翻车、抽象整活、玩梗求接梗）返回 `intent=sass`，放行后由插件注入吐槽风格提示；`sassStyle` 可覆盖默认风格文案。`judgePersona` 给判定器补上人设摘要（「这是谁、别人怎么叫它」），配合 user prompt 里的【本条消息 @ 了】（区分 @机器人 / @其他群友，并带上对方群名片）和【机器人自己的 QQ】，避免把 A @ B 的对话、或昵称也叫「大肥鱼」的群友当成机器人——判定器被要求「认 QQ 不认名字」。这是提示词层约束，不是硬跳过。字段全表、成本护栏与排查日志（`[onebot][smart]`）见 README「智能触发（smart trigger）」。

### @ 成员（atEnabled）

`channels.onebot.atEnabled`（默认 `true`）：模型用 `[[at:QQ号]]`（兼容模型自己写的 `[CQ:at,qq=QQ号]`）在群回复里 @ 成员；发送层 `connection.ts` 的 `textToSegments` 把 CQ 码拆成 OneBot `at` 段，空/非法 QQ 号在 `src/at.ts` 的 `normalizeAtMarkers` 里直接剥除，绝不把 CQ 码字面发到群里。历史消息文本会保留 `@QQ号`（`message.ts` 的 `getTextFromMessageContent`），QQ 号来源是上下文里的 `昵称(qq: 数字)`。`atEnabled: false` 时移除所有 at 标记。

### 戳一戳回应（pokeReply）

`channels.onebot.pokeReply` 让机器人回应 QQ 的「戳一戳 / 拍一拍」：只处理 `target_id === self_id` 的 poke 事件，构造一条带 `__onebotForceDispatch` 的内部消息交给 `processInboundMessage`，从而走完整 LLM 回复管线（人设、群历史、引用、分块都生效），并按 `cooldownMs`（默认 10s）做同群/同人冷却。`pokeBack=true` 时先回戳（`group_poke` / `friend_poke`），失败不影响 LLM 回应。实现见 `src/handlers/poke.ts`，接入点在 `src/service.ts` 的 `notice` 分支。

### 引用链（quoteChainDepth）

`channels.onebot.quoteChainDepth`（默认 `3`；`0` 时只取直接引用的那一条、不再上溯）：消息 3 引用 2、2 引用 1 时，`process-inbound.ts` 用 `src/quote-chain.ts` 的 `buildQuoteChain` 沿 reply 段上溯，把整条链一次性拼进 `messageText`（`formatQuoteChain`），链全文同时作为 `quotedText` 传给判定器。实现带防环、单条 300 字截断、整链 1200 字预算；`get_msg` 通过依赖注入传入（`processInboundMessage` 的 `deps.getMsg`），便于单测。

### 引用机器人时立即回复（quoteToBotReply）

`channels.onebot.quoteToBotReply`（boolean，默认 `true`，显式 `false` 关闭）：群友**直接引用机器人自己发的消息**时立即回复，等同 @——跳过 smartTrigger 的 keywords/aliases 直通与 LLM 判定，与 `smartTrigger.enabled` 无关，`requireMention: true` 时同样生效。只有「直接引用的那一条」（链尾）的发送者是机器人自己才算（`src/quote-chain.ts` 的 `quoteTargetIsSelf(chain, selfId)`），3 引用 2、2 引用 1 时若 2 是群友发的则不算；黑名单用户、`get_msg` 失败/已撤回时不生效。该路径不注入 `allowModelSilence` 的沉默提示。日志：`[onebot] quote-chain replyId=... len=N ids=... to=self`、`[onebot][smart] group=... decision=reply source=quote-to-bot replyId=... intent=answer`。

### Agent 工具注册（contracts.tools）

插件向 Agent 暴露的 `onebot_*` 工具在 `src/tools.ts` 的 `registerTools(api)` 中注册，由 `src/index.ts` 调用。OpenClaw 2026.10 起还有第二个必要条件：`openclaw.plugin.json` 必须声明 `contracts.tools`（工具名数组），否则每个工具都会被拒绝并报 `plugin must declare contracts.tools before registering agent tools`；声明与实际注册不一致也会报错（`contracts.tools is missing` / `has no matching defineToolPlugin tool`）。**加工具时两边必须同步改。**

当前工具：`onebot_send_text`、`onebot_sticker_save`、`onebot_sticker_send`、`onebot_sticker_list`、`onebot_send_image`、`onebot_recall`、`onebot_upload_file`、`onebot_get_group_msg_history`、`onebot_search_group_member`、`onebot_run_script`。

注册成功后可用 `openclaw plugins inspect openclaw-onebot --runtime` 查看 `Tools:` 段确认。

### 技能（skills）部署

`skills/` 目录随插件包分发（如 `skills/onebot-ops`、`skills/onebot-messaging`），但 OpenClaw 2026.10.x **不会扫描插件内的 skills 目录**（`openclaw skills list` 里看不到，插件清单也没有 skills 声明字段）。真正生效的位置是 agent 目录：

```bash
~/.openclaw/agents/<agentId>/agent/workshop-skills/<skill-name>/SKILL.md
```

改完 skill 后复制过去即可（**无需重启网关**），用 `openclaw skills info <name>` 验证，应看到 `Ready` 与 `Visible to model: yes`。注意该目录同时存放 workshop 自主学习生成的 skill，冲突时以 `onebot-messaging` 为准。

## 图片生成实现

### Satori 方案

使用 `satori` + `sharp` 替代 `puppeteer-core`，优势：
- 无需浏览器内核
- 启动速度快
- Serverless 友好

### 字体要求

- Satori 不支持 `.ttc` (TrueType Collection) 格式
- 使用 `.ttf` 格式字体
- macOS 推荐: `/System/Library/Fonts/Supplemental/Arial Unicode.ttf`

### Markdown 渲染

支持语法：
- `#` 标题
- `**粗体**`
- `*斜体*`
- `` `代码` `` 行内代码
- ```` ``` ```` 代码块
- `-` / `*` 列表
- `>` 引用块

## 调试技巧

### 1. 检查插件与频道注册

```bash
openclaw plugins inspect openclaw-onebot --runtime   # 应看到 channel: onebot / Services: onebot-ws
openclaw channels list --all                         # 应看到 OneBot default: installed, configured, enabled
openclaw channels status                             # 应看到 OneBot default: enabled, configured
```

### 2. 查看插件日志

```bash
# 实时查看日志
tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep onebot
```

### 3. 测试消息发送

```bash
openclaw message send \
  --channel onebot \
  --target group:1046693162 \
  -m "测试消息"
```

### 4. 验证编译输出

```bash
# 确保 dist/ 目录有最新编译结果
ls -la dist/
head -20 dist/index.js
```

## 常见问题

### 1. 字体加载失败

**错误**: `Unsupported OpenType signature ttcf`

**解决**: 更换为 `.ttf` 格式字体

### 2. Satori 布局错误

**错误**: `Expected <div> to have explicit "display: flex"`

**解决**: 确保所有容器元素都有 `display: flex`

### 3. 插件未生效 / 频道未注册

**症状**: `openclaw channels list --all` 显示 `OneBot: installed, not configured, disabled`；
Gateway 日志出现 `external plugin "openclaw-onebot" is installed without explicit trust`。

**排查步骤**:
1. 检查 `npm run build` 是否成功
2. 检查 `~/.openclaw/openclaw.json` 中 `plugins.load.paths` 是否指向插件目录
3. 检查是否存在 `plugins.entries.openclaw-onebot.enabled: true`（或把 `openclaw-onebot` 加入 `plugins.allow`）
4. 执行 `openclaw plugins enable openclaw-onebot`，再 `openclaw gateway restart`
5. 用 `openclaw plugins inspect openclaw-onebot --runtime` 确认注册了 `channel: onebot`

## 发布流程

1. 更新版本号: `package.json` 中的 `version`
2. 编译: `npm run build`
3. 提交: `git add -A && git commit -m "..." && git push origin main`
4. 打标签: `git tag -a v1.0.x -m "Release v1.0.x" && git push origin v1.0.x`

## 相关资源

- [OneBot v11 协议文档](https://github.com/botuniverse/onebot-11)
- [Satori 文档](https://github.com/vercel/satori)
- [OpenClaw 文档](https://docs.openclaw.ai)
- [Lagrange.Core](https://github.com/LagrangeDev/Lagrange.Core)

## 开发环境

- **OS**: macOS 26.2 (arm64) / Windows 11（本地测试）
- **Node.js**: v24.14.0 / v26.12.1
- **OpenClaw**: 2026.3.x ~ 2026.10.x

---

最后更新: 2026-10-28
