/**
 * OneBot TUI 配置向导
 * openclaw onebot setup
 */
import {
  cancel as clackCancel,
  confirm as clackConfirm,
  isCancel,
  note as clackNote,
  outro as clackOutro,
  select as clackSelect,
  text as clackText,
} from "@clack/prompts";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const OPENCLAW_HOME = join(homedir(), ".openclaw");
const CONFIG_PATH = join(OPENCLAW_HOME, "openclaw.json");

function guardCancel<T>(v: T | symbol): T {
  if (isCancel(v)) {
    clackCancel("已取消。");
    process.exit(0);
  }
  return v as T;
}

export async function runOneBotSetup(): Promise<void> {
  const type = guardCancel(
    await clackSelect({
      message: "连接类型",
      options: [
        { value: "forward-websocket", label: "forward-websocket（正向，主动连接 OneBot）" },
        { value: "backward-websocket", label: "backward-websocket（反向，OneBot 连接本机）" },
      ],
      initialValue: process.env.ONEBOT_WS_TYPE === "backward-websocket" ? "backward-websocket" : "forward-websocket",
    })
  );

  const host = guardCancel(
    await clackText({
      message: "主机地址",
      initialValue: process.env.ONEBOT_WS_HOST || "127.0.0.1",
    })
  );

  const portStr = guardCancel(
    await clackText({
      message: "端口",
      initialValue: process.env.ONEBOT_WS_PORT || "3001",
    })
  );

  const accessToken = guardCancel(
    await clackText({
      message: "Access Token（可选，留空回车跳过）",
      initialValue: process.env.ONEBOT_WS_ACCESS_TOKEN || "",
    })
  );

  const renderMarkdownToPlain = guardCancel(
    await clackConfirm({
      message: "是否将机器人回复中的 Markdown 渲染为纯文本再发送？（去除 **、# 等标记，推荐开启）",
      initialValue: true,
    })
  );

  const longMessageMode = guardCancel(
    await clackSelect({
      message: "长消息处理模式（单次回复超过阈值时）：",
      options: [
        { value: "normal", label: "正常发送（分段发送）" },
        { value: "og_image", label: "生成图片发送（需安装 satori 和 sharp）" },
        { value: "forward", label: "合并转发发送（发给自己后打包转发）" },
      ],
      initialValue: "normal",
    })
  );

  let ogImageRenderTheme: "default" | "dust" | "custom" = "default";
  let ogImageRenderThemePath: string | undefined;
  if (longMessageMode === "og_image") {
    const themeChoice = guardCancel(
      await clackSelect({
        message: "长消息生成图片时的渲染样式：",
        options: [
          { value: "default", label: "default（无额外样式，默认白底黑字）" },
          { value: "dust", label: "dust（内置暖色旧纸质感）" },
          { value: "custom", label: "custom（自定义 CSS 文件路径）" },
        ],
        initialValue: "default",
      })
    );
    ogImageRenderTheme = themeChoice as "default" | "dust" | "custom";
    if (themeChoice === "custom") {
      const customPath = guardCancel(
        await clackText({
          message: "CSS 文件绝对路径",
          initialValue: "",
        })
      );
      ogImageRenderThemePath = (customPath || "").trim() || undefined;
    }
  }

  const longMessageThreshold = guardCancel(
    await clackText({
      message: "长消息阈值（字符数，超过则启用上述模式）",
      initialValue: "300",
    })
  );

  let existing: any = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      existing = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    } catch {}
  }
  const prevOnebot = (existing.channels || {}).onebot;
  const whitelistInitial = Array.isArray(prevOnebot?.whitelistUserIds)
    ? prevOnebot.whitelistUserIds.join(", ")
    : "";

  const whitelistInput = guardCancel(
    await clackText({
      message: "白名单 QQ 号（逗号分隔，留空则所有人可回复）",
      initialValue: whitelistInitial,
    })
  );

  const blacklistInitial = Array.isArray(prevOnebot?.blacklistUserIds)
    ? prevOnebot.blacklistUserIds.join(", ")
    : "";

  const blacklistInput = guardCancel(
    await clackText({
      message: "黑名单 QQ 号（逗号分隔，留空则不禁用任何人）",
      initialValue: blacklistInitial,
    })
  );

  const port = parseInt(String(portStr).trim(), 10);
  if (!Number.isFinite(port)) {
    console.error("端口必须为数字");
    process.exit(1);
  }

  const channels = existing.channels || {};
  const thresholdNum = parseInt(String(longMessageThreshold).trim(), 10);
  const whitelistIds = (String(whitelistInput).trim().split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).map((s) => (/^\d+$/.test(s) ? Number(s) : null)).filter((n): n is number => n != null));
  const blacklistIds = (String(blacklistInput).trim().split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).map((s) => (/^\d+$/.test(s) ? Number(s) : null)).filter((n): n is number => n != null));
  channels.onebot = {
    ...(channels.onebot || {}),
    type,
    host: String(host).trim(),
    port,
    ...(accessToken?.trim() ? { accessToken: String(accessToken).trim() } : {}),
    enabled: true,
    requireMention: true,
    renderMarkdownToPlain,
    longMessageMode,
    ...(longMessageMode === "og_image" ? { ogImageRenderTheme, ...(ogImageRenderThemePath != null ? { ogImageRenderThemePath } : {}) } : {}),
    longMessageThreshold: Number.isFinite(thresholdNum) ? thresholdNum : 300,
    ...(whitelistIds.length > 0 ? { whitelistUserIds: whitelistIds } : {}),
    ...(blacklistIds.length > 0 ? { blacklistUserIds: blacklistIds } : {}),
  };

  // OpenClaw 2026.x 要求外部插件在 config 中显式声明信任（plugins.entries.<id>.enabled=true），
  // 否则 Gateway 只会发现插件而不会加载它，频道也就不会注册/启动。
  const plugins = { ...(existing.plugins || {}) };
  const entries = { ...(plugins.entries || {}) };
  entries["openclaw-onebot"] = { ...(entries["openclaw-onebot"] || {}), enabled: true };
  plugins.entries = entries;
  // 与 `openclaw plugins install` 行为一致：遵守已有 allow 列表策略，并把本插件纳入。
  if (Array.isArray(plugins.allow) && plugins.allow.length > 0) {
    const allow = plugins.allow.map((id: unknown) => String(id));
    if (!allow.includes("openclaw-onebot")) allow.push("openclaw-onebot");
    plugins.allow = allow;
  }
  if (Array.isArray(plugins.deny)) {
    plugins.deny = plugins.deny.map((id: unknown) => String(id)).filter((id: string) => id !== "openclaw-onebot");
  }

  const next = { ...existing, plugins, channels };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf-8");

  clackNote(`配置已保存到 ${CONFIG_PATH}`, "完成");
  clackOutro("已启用插件。运行 openclaw gateway restart 使配置生效");
}
