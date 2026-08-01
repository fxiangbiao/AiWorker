/**
 * MCP 健康检查 — 定期 ping + 自动触发重连
 */

import { McpConnectionPool } from "./connection-pool.js";

export interface HealthCheckOptions {
  intervalMs?: number;
  maxConsecutiveFailures?: number;
}

export type ReconnectCallback = (name: string) => Promise<void>;

export class McpHealthCheck {
  private pool: McpConnectionPool;
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private consecutiveFailures = new Map<string, number>();
  private pingFn: (name: string) => Promise<boolean>;
  private onReconnect: ReconnectCallback;
  private intervalMs: number;
  private maxFailures: number;

  constructor(
    pool: McpConnectionPool,
    pingFn: (name: string) => Promise<boolean>,
    onReconnect: ReconnectCallback,
    options?: HealthCheckOptions,
  ) {
    this.pool = pool;
    this.pingFn = pingFn;
    this.onReconnect = onReconnect;
    this.intervalMs = options?.intervalMs ?? 30000;
    this.maxFailures = options?.maxConsecutiveFailures ?? 3;
  }

  start(name: string): void {
    if (this.timers.has(name)) return;

    const timer = setInterval(async () => {
      const conn = this.pool.get(name);
      if (!conn || conn.state !== "connected") return;

      try {
        const ok = await this.pingFn(name);
        if (ok) {
          this.consecutiveFailures.set(name, 0);
        } else {
          this.recordFailure(name);
        }
      } catch {
        this.recordFailure(name);
      }
    }, this.intervalMs);

    this.timers.set(name, timer);
  }

  private async recordFailure(name: string): Promise<void> {
    const failures = (this.consecutiveFailures.get(name) ?? 0) + 1;
    this.consecutiveFailures.set(name, failures);

    if (failures >= this.maxFailures) {
      this.pool.setState(name, "disconnected");
      this.consecutiveFailures.set(name, 0);
      this.onReconnect(name).catch(() => {});
    }
  }

  stop(name: string): void {
    const timer = this.timers.get(name);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(name);
    }
    this.consecutiveFailures.delete(name);
  }

  stopAll(): void {
    for (const name of this.timers.keys()) {
      this.stop(name);
    }
  }

  getFailures(name: string): number {
    return this.consecutiveFailures.get(name) ?? 0;
  }
}
