/**
 * 子智能体归属注册表（Sprint 52 T7）— 记录 childSessionId → parentSessionId + parentTurnAtSpawn
 * 供回滚 B 路线查询：父 /rewind 时沿归属边展开子会话改动
 * 诚实边界：进程内生命周期，不跨重启（子智能体本身也不跨重启存活）
 */

export interface OwnershipRecord {
  parentSessionId: string;
  parentTurnAtSpawn: number;
  childSessionId: string;
  spawnedAt: number;
}

const registry = new Map<string, OwnershipRecord>();

export function registerOwnership(record: OwnershipRecord): void {
  registry.set(record.childSessionId, record);
}

export function getOwner(childSessionId: string): OwnershipRecord | undefined {
  return registry.get(childSessionId);
}

export function listByParent(parentSessionId: string): OwnershipRecord[] {
  return [...registry.values()].filter((r) => r.parentSessionId === parentSessionId);
}

export function unregisterChild(childSessionId: string): void {
  registry.delete(childSessionId);
}

/** 父会话删除时清理其全部子归属记录 */
export function purgeByParent(parentSessionId: string): number {
  let removed = 0;
  for (const [childId, rec] of registry) {
    if (rec.parentSessionId === parentSessionId) {
      registry.delete(childId);
      removed++;
    }
  }
  return removed;
}

export function clearRegistry(): void {
  registry.clear();
}
