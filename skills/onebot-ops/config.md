# 配置参数

配置文件位置：`~/.openclaw/openclaw.json` 的 `channels.onebot`（也可用下方环境变量提供）。
交互式配置运行 `openclaw onebot setup`。

## 基础连接

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| type | string | `forward-websocket` | `forward-websocket`（插件主动连接）/ `backward-websocket`（OneBot 连过来） |
| host | string | - | OneBot 主机地址 |
| port | number | - | 端口 |
| accessToken | string | - | 访问令牌（可选） |
| path | string | `/onebot/v11/ws` | 反向 WS 路径 |

## 触发与回复

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| requireMention | boolean | true | 群聊是否需 @ 才回复 |
| triggerKeywords | string[] | [] | `requireMention=false` 时生效的触发关键词 |
| triggerMode | `prefix` \| `contains` | `prefix` | 关键词匹配模式 |
| historyLimit | number | 20 | 触发回复时附带的群聊上下文条数（0 关闭；最多 100） |
| quoteEnabled | boolean | true | 允许模型用 `[[quote:消息ID]]` 引用群里某条消息 |
| quoteChainDepth | number | 3 | 引用链向上追溯层数（0 = 只取直接引用的那一条；上限 10） |
| quoteToBotReply | boolean | true | 群友直接引用机器人自己的发言时立即回复（等同 @，跳过智能触发判定） |
| atEnabled | boolean | true | 允许模型用 `[[at:QQ号]]` 在回复里 @ 群成员 |
| stickerEnabled | boolean | true | 群聊上下文里附带本地表情包库摘要 |
| stickerContextLimit | number | 8 | 上下文里展示的表情包条数（0 关闭；最多 30） |
| whitelistUserIds | number[] | [] | 白名单 QQ 号；非空时仅白名单内用户可触发 AI |
| blacklistUserIds | number[] | [] | 黑名单 QQ 号；在黑名单内的用户无法触发 AI（优先级低于白名单） |
| replyWhenWhitelistDenied | boolean | true | 白名单外用户触发时是否回复「权限不足」 |
| thinkingEmojiId | number | 60 | `set_msg_emoji_like` 表情 ID |
| groupIncrease | object | 关闭 | 新成员入群欢迎（enabled、message、command、cwd），详见 [receive.md](receive.md) |
| cronJobs | array | [] | 内置定时任务（无 AI 介入），详见下方 |

## 智能触发（1.3.0 新增 `smartTrigger`）

非 @ 群消息的两段式判定：关键词 / 别名直通（零 token），未命中再调用宿主 LLM 判断是否接话。
**默认关闭，必须显式 `enabled: true` 才生效。**

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| enabled | boolean | false | 总开关（`requireMention=true` 时也不会自动开启） |
| groups | number[] | [] | 只对这些群号生效；空 = 全部群 |
| keywords | string[] | [] | 直通关键词；为空时继承 `triggerKeywords` |
| keywordMode | `prefix` \| `contains` | `contains` | 关键词匹配模式（与全局 `triggerMode` 默认不同） |
| aliases | string[] | [] | 机器人别名（QQ 昵称等），包含即直通 |
| threshold | number | 0.6 | LLM 置信度阈值（0~1） |
| timeoutMs | number | 8000 | 单次判定超时（1000~60000 ms） |
| minIntervalMs | number | 3000 | 同群两次判定最小间隔（0~600000 ms） |
| cooldownMs | number | 30000 | 放行回复后同群冷却（0~3600000 ms） |
| maxRepliesPerHour | number | 6 | 同群每小时最多放行次数（0~100，0 = 不限） |
| historyLimit | number | 10 | 喂给判定模型的最近消息条数（0~30） |
| maxInputChars | number | 2000 | 判定输入字符上限（200~8000），超出从最旧截断 |
| model | string | `""` | 覆盖判定模型；空 = 宿主 agent 默认模型（需宿主 `plugins.entries.openclaw-onebot.llm.allowModelOverride=true`） |
| fallback | `ignore` \| `reply` | `ignore` | LLM 不可用 / 超时 / 解析失败时的策略 |
| minMessageChars | number | 2 | 过短消息（纯表情/符号）不判定，直接忽略（0~200） |
| allowModelSilence | boolean | false | 放行后允许模型输出 `silentMarker` 自主沉默 |
| silentMarker | string | `[[silent]]` | 沉默标记 |
| sassEnabled | boolean | true | 轻松场合允许判定器返回 `intent=sass` 并注入吐槽风格 |
| sassStyle | string | `""` | 自定义吐槽风格提示；空 = 内置文案 |
| judgePersona | string | `""` | 判定器使用的人设摘要；空 = 内置默认 |

数值字段都会 clamp 到上表范围，非法类型回落默认值，解析过程永不抛错。完整护栏与日志说明见 README「智能触发（smart trigger）」。

## 戳一戳回应（1.3.0 新增 `pokeReply`）

被「戳一戳 / 拍一拍」时构造内部消息，走完整 LLM 回复管线。**默认关闭。**

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| enabled | boolean | false | 总开关，需显式开启 |
| cooldownMs | number | 10000 | 同群/同人冷却（0~600000 ms，0 = 不去重） |
| pokeBack | boolean | false | 是否先回戳（`group_poke` / `friend_poke`），失败不影响 LLM 回应 |
| prompt | string | `（戳了戳你）` | 注入给模型的场景文本 |

## 发送与长消息

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| renderMarkdownToPlain | boolean | true | 将回复中的 Markdown 转纯文本再发送 |
| collapseDoubleNewlines | boolean | true | 将连续空行压缩为单个换行 |
| normalModeFlushIntervalMs | number | 1200 | normal 模式聚合发送等待窗口（200~5000 ms） |
| normalModeFlushChars | number | 160 | normal 模式提前发送的字符阈值（20~2000） |
| longMessageMode | `normal` \| `og_image` \| `forward` | `normal` | 长消息处理模式 |
| longMessageThreshold | number | 300 | 长消息阈值（字符数） |
| ogImageRenderTheme | `default` \| `dust` \| `custom` | `default` | og_image 模式渲染主题 |
| ogImageRenderThemePath | string | `""` | `custom` 时的 CSS 文件绝对路径 |

## 环境变量

| 变量 | 说明 |
|------|------|
| ONEBOT_WS_TYPE | forward-websocket / backward-websocket |
| ONEBOT_WS_HOST | 主机地址 |
| ONEBOT_WS_PORT | 端口 |
| ONEBOT_WS_ACCESS_TOKEN | 访问令牌 |
| ONEBOT_WS_PATH | 反向 WS 路径 |

## cronJobs 配置

在 `openclaw.json` 中配置内置定时任务，直接执行脚本并推送到群，无需 AI 介入：

```json
{
  "channels": {
    "onebot": {
      "cronJobs": [
        {
          "name": "每日科技新闻",
          "cron": "0 8 * * *",
          "timezone": "Asia/Shanghai",
          "script": "./Tiphareth/src/openclaw/cron/daily-news.ts",
          "groupIds": [782833642, 1046693162]
        }
      ]
    }
  }
}
```

脚本需导出 `default` / `run` / `execute` 函数，接收 `ctx: { onebot, groupIds }`。

## 长消息处理

当单次回复超过 `longMessageThreshold` 字符时，根据 `longMessageMode` 处理：

| 模式 | 说明 |
|------|------|
| normal | 正常分段发送（默认） |
| og_image | 将 Markdown 渲染为图片发送。需安装 `satori` 和 `sharp`：`npm install satori sharp`。此模式下保留 Markdown 格式与代码高亮，无需浏览器内核 |
| forward | 将各块消息先发给自己，再打包为合并转发发送。需 OneBot 实现支持 `send_group_forward_msg` / `send_private_forward_msg` |

## 发送调试日志

设置环境变量 `OPENCLAW_ONEBOT_SEND_DEBUG=1` 可启用发送调试日志，写入插件根目录的 `send-debug.log`（绝对路径见日志首行）。
