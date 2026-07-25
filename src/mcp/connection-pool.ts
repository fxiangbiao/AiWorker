/**
 * MCP 连接池 — 管理连接状态与重连策略
 * 设计依据：Section 3.4 — 长连接复用，自动重连
 */

import type { McpServerConfig } from "../types.js";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting" | "dead";

export interface PooledConnection {
  name: string;
  config: McpServerConfig;
  state: ConnectionState;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
  lastConnectedAt: number | null;
  lastError: string | null;
}

export class McpConnectionPool {
  private connections = new Map<string, PooledConnection>();

  register(name: string, config: McpServerConfig): PooledConnection {
    const existing = this.connections.get(name);
    if (existing) return existing;

    const pooled: PooledConnection = {
      name,
      config,
      state: "disconnected",
      reconnectAttempts: 0,
      maxReconnectAttempts: 5,
      lastConnectedAt: null,
      lastError: null,
    };
    this.connections.set(name, pooled);
    return pooled;
  }

  get(name: string): PooledConnection | undefined {
    return this.connections.get(name);
  }

  remove(name: string): void {
    this.connections.delete(name);
  }

  setState(name: string, state: ConnectionState): void {
    const conn = this.connections.get(name);
    if (conn) {
      conn.state = state;
      if (state === "connected") {
        conn.reconnectAttempts = 0;
        conn.lastConnectedAt = Date.now();
        conn.lastError = null;
      }
    }
  }

  recordError(name: string, error: string): void {
    const conn = this.connections.get(name);
    if (conn) {
      conn.lastError = error;
    }
  }

  /**
   * 计算下次重连延迟（指数退避）
   * delay = min(1000 * 2^attempts, 30000)
   */
  getReconnectDelay(name: string): number {
    const conn = this.connections.get(name);
    if (!conn) return 30000;
    return Math.min(1000 * Math.pow(2, conn.reconnectAttempts), 30000);
  }

  /**
   * 尝试重连，返回是否应该继续重试
   */
  shouldRetry(name: string): boolean {
    const conn = this.connections.get(name);
    if (!conn || conn.state === "dead") return false;
    if (conn.reconnectAttempts >= conn.maxReconnectAttempts) {
      conn.state = "dead";
      return false;
    }
    conn.reconnectAttempts++;
    conn.state = "reconnecting";
    return true;
  }

  getAll(): PooledConnection[] {
    return [...this.connections.values()];
  }

  getStatus(name: string): { state: ConnectionState; reconnectAttempts: number; lastError: string | null } {
    const conn = this.connections.get(name);
    if (!conn) return { state: "disconnected", reconnectAttempts: 0, lastError: null };
    return {
      state: conn.state,
      reconnectAttempts: conn.reconnectAttempts,
      lastError: conn.lastError,
    };
  }
}
