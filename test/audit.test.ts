/**
 * 审计日志查询单测（Sprint 42 A1：审计 Tab 数据源）
 * 覆盖：queryRecent 最新在前 + limit 截断、action 前缀过滤、auditLogger 透出
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDir, setupEnv, teardownEnv } from "./helpers.js";
import { auditLogger } from "../src/core/audit-logger.js";

describe("审计日志查询（Sprint 42 A1）", () => {
  beforeEach(() => {
    // setupEnv 内部 initAuditLog(dir)
    setupEnv(makeTestDir("audit"));
  });

  afterEach(() => {
    auditLogger.close();
    teardownEnv();
  });

  it("queryRecent 最新在前 + limit 截断", () => {
    for (let i = 0; i < 5; i++) {
      auditLogger.log({ timestamp: i, agentId: "t", sessionId: "s", action: "tool:fs_write", target: "x", result: "success" });
    }
    const recent = auditLogger.queryRecent(2);
    expect(recent).toHaveLength(2);
    expect(recent[0]!.timestamp).toBe(4);
    expect(recent[1]!.timestamp).toBe(3);
  });

  it("queryRecent 同毫秒批次按插入序倒排（id 断链，严格最新在前）", () => {
    const same = 1000;
    auditLogger.log({ timestamp: same, agentId: "t", sessionId: "s", action: "tool:fs_read", target: "a", result: "success" });
    auditLogger.log({ timestamp: same, agentId: "t", sessionId: "s", action: "tool:fs_read", target: "b", result: "success" });
    auditLogger.log({ timestamp: same, agentId: "t", sessionId: "s", action: "tool:fs_read", target: "c", result: "success" });
    const recent = auditLogger.queryRecent(10);
    // 同一毫秒内：后插入的（id 更大）排前面
    expect(recent[0]!.target).toBe("c");
    expect(recent[1]!.target).toBe("b");
    expect(recent[2]!.target).toBe("a");
  });

  it("queryRecent action 前缀过滤", () => {
    auditLogger.log({ timestamp: 1, agentId: "t", sessionId: "s", action: "app:generate", target: "a", result: "success" });
    auditLogger.log({ timestamp: 2, agentId: "t", sessionId: "s", action: "evolution:apply", target: "e", result: "success" });
    auditLogger.log({ timestamp: 3, agentId: "t", sessionId: "s", action: "evolution:rollback", target: "e", result: "success" });
    const evo = auditLogger.queryRecent(100, "evolution:");
    expect(evo).toHaveLength(2);
    expect(evo[0]!.action).toBe("evolution:rollback");
    const app = auditLogger.queryRecent(100, "app:");
    expect(app).toHaveLength(1);
  });

  it("queryRecent limit 非法值收敛（0/负数/超大）", () => {
    auditLogger.log({ timestamp: 1, agentId: "t", sessionId: "s", action: "tool:fs_read", target: "x", result: "success" });
    expect(auditLogger.queryRecent(0).length).toBeGreaterThanOrEqual(1);
    expect(auditLogger.queryRecent(-5).length).toBeGreaterThanOrEqual(1);
    expect(auditLogger.queryRecent(99999)).toHaveLength(1);
  });
});
