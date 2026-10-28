/**
 * OpenClaw / ClawdBot Plugin SDK 懒加载
 *
 * 注意：openclaw 包的 exports 没有 "./plugin-sdk" 根入口，
 * 历史能力位于 "./plugin-sdk/reply-history" 子路径，因此按候选顺序逐个尝试。
 */

let sdkLoaded = false;
let buildPendingHistoryContextFromMap: any;
let recordPendingHistoryEntry: any;
let clearHistoryEntriesIfEnabled: any;

const SDK_CANDIDATES = [
  "openclaw/plugin-sdk/reply-history",
  "openclaw/plugin-sdk",
  "clawdbot/plugin-sdk",
  "clawdbot/plugin-sdk/reply-history",
];

export async function loadPluginSdk(): Promise<void> {
  if (sdkLoaded) return;
  for (const spec of SDK_CANDIDATES) {
    try {
      const sdk: any = await import(spec);
      buildPendingHistoryContextFromMap = sdk.buildPendingHistoryContextFromMap;
      // OpenClaw 2026.10 导出名为 recordPendingHistoryEntryIfEnabled
      recordPendingHistoryEntry =
        sdk.recordPendingHistoryEntryIfEnabled ?? sdk.recordPendingHistoryEntry;
      clearHistoryEntriesIfEnabled = sdk.clearHistoryEntriesIfEnabled;
      if (buildPendingHistoryContextFromMap || recordPendingHistoryEntry) {
        sdkLoaded = true;
        return;
      }
    } catch {
      // 尝试下一个候选
    }
  }
  console.warn("[onebot] plugin-sdk not found, history features disabled");
  sdkLoaded = true;
}

export function getSdk() {
  return {
    buildPendingHistoryContextFromMap,
    recordPendingHistoryEntry,
    clearHistoryEntriesIfEnabled,
  };
}
