/**
 * forward（合并转发）模式的待处理会话状态
 *
 * longMessageMode=forward 时，非 final 的 deliver 只暂存不发送；
 * 这里记录「正在等 final」的会话，并定期清理迟迟没有 final 的残留，
 * 避免崩溃/中断后内存里留下永远清不掉的 key。
 */

/** forward 模式下待处理的会话（replySessionId → 最近一次写入时间） */
const forwardPendingSessions = new Map<string, number>();
const FORWARD_PENDING_TTL_MS = 5 * 60 * 1000; // 5 分钟
const FORWARD_CLEANUP_INTERVAL_MS = 60 * 1000; // 每分钟清理一次

function cleanupForwardPendingSessions(): void {
    const now = Date.now();
    const toDelete: string[] = [];
    for (const [id, ts] of forwardPendingSessions) {
        if (now - ts > FORWARD_PENDING_TTL_MS) toDelete.push(id);
    }
    for (const id of toDelete) forwardPendingSessions.delete(id);
}

let forwardCleanupTimer: ReturnType<typeof setInterval> | null = null;

/** 标记某会话正在等待 forward 汇总 */
export function markForwardPending(replySessionId: string): void {
    forwardPendingSessions.set(replySessionId, Date.now());
}

/** 清除某会话的 forward 等待标记 */
export function clearForwardPending(replySessionId: string): void {
    forwardPendingSessions.delete(replySessionId);
}

/** 启动定期清理（幂等；unref，不阻止进程退出） */
export function startForwardCleanupTimer(): void {
    if (forwardCleanupTimer) return;
    forwardCleanupTimer = setInterval(cleanupForwardPendingSessions, FORWARD_CLEANUP_INTERVAL_MS);
    // 后台清理不应阻止进程退出，否则 CLI 子命令执行完会挂住（见 openclaw onebot setup）。
    forwardCleanupTimer.unref?.();
}
