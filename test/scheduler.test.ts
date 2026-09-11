/**
 * 定时调度器测试（Sprint 30）
 * 覆盖：cron 下次触发计算 / 配置加载（BOM/缺失） / 增删持久化 / 到点触发 submit / 非法 cron 拒绝
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { makeTestDir, teardownEnv } from "./helpers.js";
import { initAuditLog } from "../src/core/audit-logger.js";
import { nextFireAt, loadScheduleConfig, saveScheduleConfig, Scheduler } from "../src/core/scheduler.js";

const dir = makeTestDir("scheduler");
const cfgPath = resolve(dir, "schedule.json");

// 审计日志落到本测试目录：定时触发会写审计，不能依赖 cwd 下存在 data/
beforeAll(() => {
  initAuditLog(dir);
});

afterAll(() => {
  teardownEnv();
});

describe("22. Scheduler 定时调度", () => {
  it("nextFireAt：合法 cron 返回未来时间戳，非法返回 null", () => {
    expect(nextFireAt("0 8 * * *")).not.toBeNull();
    expect(nextFireAt("not-a-cron")).toBeNull();
    expect(nextFireAt("*/15 * * * *")).toBeGreaterThan(Date.now());
  });

  it("loadScheduleConfig：缺失回退空数组；BOM 容错解析", () => {
    expect(loadScheduleConfig(resolve(dir, "no.json"))).toEqual([]);
    writeFileSync(cfgPath, '\uFEFF{"jobs":[{"id":"a","cron":"0 8 * * *","prompt":"早报","agentId":"default"}]}', "utf-8");
    const jobs = loadScheduleConfig(cfgPath);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe("a");
    expect(jobs[0]!.prompt).toBe("早报");
    expect(jobs[0]!.agentId).toBe("default");
  });

  it("addJob 持久化并拒绝非法 cron", () => {
    const submit = vi.fn();
    const s = new Scheduler();
    s.init({ submit }, cfgPath);
    expect(s.addJob({ id: "ok", cron: "0 9 * * *", prompt: "提醒", agentId: "coding" })).toBe(true);
    expect(s.getJobs()).toHaveLength(1);
    expect(JSON.parse(readFileSync(cfgPath, "utf-8")).jobs).toHaveLength(1);
    expect(s.addJob({ id: "bad", cron: "junk", prompt: "x" })).toBe(false);
    expect(s.getJobs()).toHaveLength(1);
  });

  it("removeJob 移除并持久化", () => {
    const s = new Scheduler();
    s.init({ submit: vi.fn() }, cfgPath);
    s.addJob({ id: "r1", cron: "0 9 * * *", prompt: "p" });
    expect(s.removeJob("r1")).toBe(true);
    expect(s.getJobs()).toHaveLength(0);
    expect(s.removeJob("nope")).toBe(false);
    expect(existsSync(cfgPath)).toBe(true);
  });

  it("到点触发 submit（fake timers，每分钟任务 60s 跨越两个整分边界）", async () => {
    vi.useFakeTimers();
    try {
      const submit = vi.fn();
      const s = new Scheduler();
      s.init({ submit }, cfgPath);
      s.addJob({ id: "fire", cron: "*/1 * * * *", prompt: "每分钟任务", agentId: "default" });
      s.start();
      // 推进 60.001s：首次注册延时 ~29s + 重排后的 ~31s，跨两个整分边界 → 2 次
      vi.advanceTimersByTime(60_001);
      expect(submit).toHaveBeenCalledWith("default", "每分钟任务");
      expect(submit.mock.calls.length).toBeGreaterThanOrEqual(1);
      // 继续推进同样触发
      vi.advanceTimersByTime(60_001);
      expect(submit.mock.calls.length).toBeGreaterThanOrEqual(2);
      s.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  beforeEach(() => {
    try {
      writeFileSync(cfgPath, "", "utf-8");
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    try {
      writeFileSync(cfgPath, "", "utf-8");
    } catch {
      /* ignore */
    }
    vi.useRealTimers();
  });
});
