/**
 * 自然语言调度解析测试（Sprint 30 增强）
 * 覆盖：每 N 分钟/小时、每天+时间、每周X、每月X号、时间词（下午/晚上 +12）、
 *       整点/半点/XX:XX、任务描述剥离、无效输入 null
 */

import { describe, it, expect } from "vitest";
import { parseNaturalSchedule } from "../src/core/nl-schedule.js";

describe("23. 自然语言调度解析", () => {
  it("每天早上8点 → 0 8 * * *，剥离时间表达", () => {
    const r = parseNaturalSchedule("每天早上8点生成早报");
    expect(r).toEqual({ cron: "0 8 * * *", prompt: "生成早报" });
  });

  it("每天 9:30 → 30 9 * * *", () => {
    const r = parseNaturalSchedule("每天9:30检查服务");
    expect(r).toEqual({ cron: "30 9 * * *", prompt: "检查服务" });
  });

  it("每30分钟 → */30 * * * *", () => {
    const r = parseNaturalSchedule("每30分钟清理临时文件");
    expect(r).toEqual({ cron: "*/30 * * * *", prompt: "清理临时文件" });
  });

  it("每2小时 → 0 */2 * * *", () => {
    const r = parseNaturalSchedule("每2小时同步数据");
    expect(r).toEqual({ cron: "0 */2 * * *", prompt: "同步数据" });
  });

  it("每周一下午3点 → 0 15 * * 1", () => {
    const r = parseNaturalSchedule("每周一下午3点开例会");
    expect(r).toEqual({ cron: "0 15 * * 1", prompt: "开例会" });
  });

  it("每周一到周五9点 → 0 9 * * 1-5", () => {
    const r = parseNaturalSchedule("每周一到周五9点签到");
    expect(r).toEqual({ cron: "0 9 * * 1-5", prompt: "签到" });
  });

  it("每周末10点 → 0 10 * * 0,6", () => {
    const r = parseNaturalSchedule("每周末10点整理相册");
    expect(r).toEqual({ cron: "0 10 * * 0,6", prompt: "整理相册" });
  });

  it("每月1号8点半 → 30 8 1 * *", () => {
    const r = parseNaturalSchedule("每月1号8点半生成账单");
    expect(r).toEqual({ cron: "30 8 1 * *", prompt: "生成账单" });
  });

  it("每晚10点 → 22 点（+12 偏移）", () => {
    const r = parseNaturalSchedule("每晚10点写日记");
    expect(r).toEqual({ cron: "0 22 * * *", prompt: "写日记" });
  });

  it("中午12点 → 12 点不偏移", () => {
    const r = parseNaturalSchedule("每天中午12点午休提醒");
    expect(r).toEqual({ cron: "0 12 * * *", prompt: "午休提醒" });
  });

  it("无频率默认每天", () => {
    const r = parseNaturalSchedule("8点检查天气");
    expect(r).toEqual({ cron: "0 8 * * *", prompt: "检查天气" });
  });

  it("无法识别返回 null", () => {
    expect(parseNaturalSchedule("帮我写个程序")).toBeNull();
    expect(parseNaturalSchedule("")).toBeNull();
  });
});
