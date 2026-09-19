/**
 * 回合序号注册表 — turnLogger（轮次日志/事件）与检查点共用同一序号，避免两套计数器漂移
 * pendingTurn = 当前进行中的回合号（onMessage 时预测，onTaskComplete 时提交）；回合异常不提交，下一轮复用同一号
 * 进程内计数重启即归零，故支持注入"已完成回合数"解析器（bootstrap 按会话查已提交回合），否则新回合会并入旧 manifest
 */

const completed = new Map<string, number>();

/** 已完成回合数解析器（同步注入；未注入时行为与"无回填"完全一致） */
let resolver: ((sessionId: string) => number) | null = null;

export function setCompletedTurnsResolver(fn: ((sessionId: string) => number) | null): void {
  resolver = fn;
}

/** 当前进行中的回合号（未提交时=已完成数+1） */
export function pendingTurn(sessionId: string): number {
  return completedTurns(sessionId) + 1;
}

/** 提交回合（onTaskComplete）：返回本回合号 */
export function commitTurn(sessionId: string): number {
  const turn = pendingTurn(sessionId);
  completed.set(sessionId, turn);
  return turn;
}

/** 已完成回合数：内存计数为准；本进程首次问到的会话按解析器回填（无解析器即 0，解析失败同样按 0 处理） */
export function completedTurns(sessionId: string): number {
  const known = completed.get(sessionId);
  if (known !== undefined) return known;
  let fromStore = 0;
  if (resolver) {
    try {
      fromStore = resolver(sessionId);
    } catch {
      fromStore = 0;
    }
  }
  const value = Number.isFinite(fromStore) && fromStore > 0 ? Math.floor(fromStore) : 0;
  completed.set(sessionId, value);
  return value;
}

/** 重置（会话删除 / 测试清理）；不传 sessionId 则全清 */
export function resetTurns(sessionId?: string): void {
  if (sessionId === undefined) completed.clear();
  else completed.delete(sessionId);
}
