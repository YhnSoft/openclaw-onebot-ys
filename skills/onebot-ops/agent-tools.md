# OneBot Agent 工具与 CLI

插件通过 WebSocket 与 OneBot（Lagrange.Core / go-cqhttp）通信，提供 **Agent 工具**（供 Cron/脚本/AI 调用）和部分等价的 **CLI 命令**（供人工或工作流调用）。

AI 或脚本应优先使用 **CLI**（能用的场景），便于复现、调试和文档化；表情包与撤回没有 CLI，只能用 Agent 工具。

## 工具一览

| 能力 | Agent 工具 | CLI |
|------|------|------|
| 发送文本 | `onebot_send_text` | `openclaw message send --channel onebot ... --message` |
| 发送图片 | `onebot_send_image` | `openclaw message send --channel onebot ... --media` |
| 保存表情包 | `onebot_sticker_save` | 无（仅 Agent 工具） |
| 发表情包 | `onebot_sticker_send` | 无（仅 Agent 工具） |
| 列表情包 | `onebot_sticker_list` | 无（仅 Agent 工具） |
| 撤回消息 | `onebot_recall` | 无（仅 Agent 工具） |
| 上传文件 | `onebot_upload_file` | `openclaw onebot upload-file` |
| 群历史 | `onebot_get_group_msg_history` | `openclaw onebot get-group-msg-history` |
| 查群成员 QQ | `onebot_search_group_member` | `openclaw onebot search-group-member` |
| 跑脚本 | `onebot_run_script` | 由 `cronJobs.script` 等工作流调用 |

`target` 一律为 `group:群号` 或 `user:QQ号`（工具内部也兼容 `onebot:` 前缀）。WS 未连接时工具会返回「OneBot 未连接」。

---

## 前置条件

- **Gateway 已启动**：`openclaw gateway`（或 `openclaw gateway run`）
- OneBot 已运行并连接；若为正向 WS，CLI 会按配置自动建连
- 配置：`openclaw.json` 的 `channels.onebot` 或环境变量 `ONEBOT_WS_*`

---

## 1. 发送文本 `onebot_send_text`

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `target` | ✅ | string | `user:QQ号` 或 `group:群号` |
| `text` | ✅ | string | 要发送的文本（`renderMarkdownToPlain` 开启时会转纯文本） |
| `replyToMessageId` | - | number \| string | 引用某条消息，ID 取自上下文里的 `[#数字]` |

返回「发送成功，消息ID: xxx」，该 ID 可用于 `onebot_recall`。

CLI 等价：

```bash
openclaw message send --channel onebot --target group:<群号> --message "内容"
openclaw message send --channel onebot --target user:<QQ号> --message "内容"
```

---

## 2. 发送图片 `onebot_send_image`

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `target` | ✅ | string | `user:QQ号` 或 `group:群号` |
| `image` | ✅ | string | URL、本地路径（可带 `file://`）或 `base64://` |

返回「图片发送成功，消息ID: xxx」。

CLI 等价：

```bash
openclaw message send --channel onebot --target group:<群号> --media "file:///path/to.png"
openclaw message send --channel onebot --target user:<QQ号> --media "https://example.com/pic.jpg"
```

---

## 3. 保存表情包 `onebot_sticker_save`

把一张图记录到本地表情包库，之后可用 `onebot_sticker_send` 发送。

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `image` | ✅ | string | 图片 URL 或本地路径（群里消息的 `[图片: url]`） |
| `note` | - | string | 这张表情包的含义/情绪（如「无语」「点赞」），供以后按关键词检索 |
| `tags` | - | string[] | 可选标签 |

返回「已记录表情包 <id>（含义）」，能下载到本地时会补「已保存到本地」。

---

## 4. 发表情包 `onebot_sticker_send`

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `target` | ✅ | string | `user:QQ号` 或 `group:群号` |
| `query` | - | string | 关键词，匹配备注/标签（如「无语」「可爱」）；不传则随机 |
| `stickerId` | - | string | 指定表情包 id（优先级高于 `query`） |

库为空时返回「表情包库是空的」。返回「已发送表情包 <id>（含义），消息ID: xxx」。

---

## 5. 列表情包 `onebot_sticker_list`

无参数。返回表情包总数与最近 50 张的 `id：含义 [标签] 用过N次`。

---

## 6. 撤回消息 `onebot_recall`

撤回**机器人自己发出的**消息（说错话时用）。

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `target` | - | string | `group:群号` 或 `user:QQ号`；不传 `messageId` 时用它定位「最近一条」 |
| `messageId` | - | number \| string | 要撤回的消息 ID（发送工具返回的「消息ID」） |

- `target` 与 `messageId` 至少给一个；两个都给时以 `messageId` 为准。
- 不传 `messageId`：撤回该会话里机器人**最近发送的一条**（普通回复与所有发送工具都会记录）。
- 只能撤回自己发的；QQ 通常只允许 **2 分钟内**撤回。
- 失败会返回具体原因（超时 / 无权限 / ID 不存在），不要反复重试。

---

## 7. 上传文件 `onebot_upload_file`

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `target` | ✅ | string | `user:QQ号` 或 `group:群号` |
| `file` | ✅ | string | 本地文件绝对路径 |
| `name` | ✅ | string | 群里显示的文件名 |

CLI 等价：

```bash
openclaw onebot upload-file --target group:<群号> --file <本地绝对路径> --name <显示文件名>
openclaw onebot upload-file --target user:<QQ号> --file <本地绝对路径> --name <显示文件名>
```

---

## 8. 群历史 `onebot_get_group_msg_history`

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `group_id` | ✅ | number | 群号 |
| `hours` | - | number | 指定则获取「从现在到过去 N 小时」的消息（按时间范围分页拉取） |
| `count` | - | number | 单页条数（未指定 `hours` 时生效），默认 50 |
| `message_seq` | - | number | 起始消息序号（分页用，未指定 `hours` 时生效） |
| `message_id` | - | number | 起始消息 ID（未指定 `hours` 时生效） |
| `limit` | - | number | 指定 `hours` 时最多返回条数，默认 3000 |

结果始终从旧到新；每条为 `[时间] 昵称: 内容`（内容截断 200 字）。

CLI 等价（`--chunk-size`、`--limit` 仅在指定 `--hours` 时有意义；`--message-id` 只有工具参数，CLI 用 `--message-seq`）：

```bash
openclaw onebot get-group-msg-history --group-id <群号>
openclaw onebot get-group-msg-history --group-id <群号> --hours 24
openclaw onebot get-group-msg-history --group-id <群号> --hours 1 --limit 500 --chunk-size 100
openclaw onebot get-group-msg-history --group-id <群号> --count 50 --message-seq <序号>
```

---

## 9. 查群成员 QQ `onebot_search_group_member`

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `group_id` | ✅ | number | 群号 |
| `name` | ✅ | string | 要搜索的名字（群名片或昵称，模糊匹配） |

返回 `QQ: 数字  展示名: xxx` 列表（群名片优先）。

CLI 等价：

```bash
openclaw onebot search-group-member --group-id <群号> --name <名字>
```

---

## 10. 执行脚本 `onebot_run_script`

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `scriptPath` | ✅ | string | 脚本路径（相对 `process.cwd()` 或绝对），支持 `.mjs` / `.ts` / `.mts` |
| `groupIds` | - | number[] | 要处理的群号列表 |

脚本需导出 `default` / `run` / `execute` 函数之一，接收 `ctx: { onebot, groupIds }`；`ctx.onebot` 提供 `sendGroupMsg`、`sendGroupImage`、`sendPrivateMsg`、`sendPrivateImage`、`getGroupMsgHistory`、`getGroupMsgHistoryInRange`、`getGroupInfo`、`getStrangerInfo`、`getGroupMemberInfo`、`searchGroupMemberByName`、`getAvatarUrl`。

Cron 场景也可直接在 `cronJobs` 里配置 `script`（见 [config.md](config.md)）。

---

## 使用建议

- **AI / 自动化**：优先用 CLI（能用的场景），便于在 Skill 中写明调用方式、可复现。
- **Cron / 内置任务**：在 `openclaw.json` 的 `cronJobs` 中配置 `script`，脚本内使用 `ctx.onebot` 或子进程调用 CLI。
- **临时查询**：直接运行 `openclaw onebot search-group-member ...`。
- **开发注意**：新增 Agent 工具时，必须同步在 `openclaw.plugin.json` 的 `contracts.tools` 中登记，否则 OpenClaw 2026.10+ 会拒绝注册（详见 AGENTS.md「Agent 工具注册」）。
