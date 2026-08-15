/**
 * 持久终端会话单测（Sprint 26）
 * 覆盖：输出解析、cd 跨调用持久、超时销毁会话并自动重启、end 关闭
 */

import { describe, it, expect, afterAll } from "vitest";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { terminalSessionPool } from "../src/tools/terminal-session.js";

afterAll(() => {
  terminalSessionPool.clear();
});

describe("terminal_session 持久会话", () => {
  it("exec 解析命令输出（marker 分隔）", async () => {
    const r = await terminalSessionPool.exec("t-echo", "echo AWN-HELLO", 5000);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("AWN-HELLO");
  });

  it("cd 跨调用持久（工作目录保留）", async () => {
    const sub = resolve(process.cwd(), "data-test", "terminal-session-sub");
    mkdirSync(sub, { recursive: true });
    await terminalSessionPool.exec("t-cd", `cd "${sub}"`, 5000);
    const r = await terminalSessionPool.exec("t-cd", "cd", 5000);
    expect(r.stdout.replace(/\r/g, "")).toContain("terminal-session-sub");
  });

  it("超时销毁会话，下次 exec 自动重启", async () => {
    const r1 = await terminalSessionPool.exec("t-timeout", "ping -n 20 127.0.0.1", 300);
    expect(r1.ok).toBe(false);
    expect(r1.timedOut).toBe(true);
    // 会话已被销毁 → 自动重启后仍可正常执行
    const r2 = await terminalSessionPool.exec("t-timeout", "echo AWN-AGAIN", 5000);
    expect(r2.ok).toBe(true);
    expect(r2.stdout).toContain("AWN-AGAIN");
  }, 15000);

  it("end 关闭会话", async () => {
    await terminalSessionPool.exec("t-end", "echo before", 5000);
    terminalSessionPool.end("t-end");
    // end 后再次 exec 会自动重新启动
    const r = await terminalSessionPool.exec("t-end", "echo AWN-AFTER", 5000);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("AWN-AFTER");
  });
});
