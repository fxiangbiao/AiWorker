/**
 * 回合序号注册表 — turnLogger（轮次日志/事件）与检查点共用同一序号，避免两套计数器漂移
 * pendingTurn = 当前进行中的回合号（onMessage 时预测，onTaskComplete 时提交）；回合异常不提交，下一轮复用同一号
 */

const completed = new Map<string, number>();

/** 当前进行中的回合号（未提交时=已完成数+1） */
export function pendingTurn(sessionId: string): number {
  return (completed.get(sessionId) ?? 0) + 1;
}

/** 提交回合（onTaskComplete）：返回本回合号 */
export function commitTurn(sessionId: string): number {
  const turn = pendingTurn(sessionId);
  completed.set(sessionId, turn);
  return turn;
}

/** 已完成回合数 */
export function completedTurns(sessionId: string): number {
  return completed.get(sessionId) ?? 0;
}

/** 重置（会话删除 / 测试清理）；不传 sessionId 则全清 */
export function resetTurns(sessionId?: string): void {
  if (sessionId === undefined) completed.clear();
  else completed.delete(sessionId);
}
