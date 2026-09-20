/**
 * 自然语言调度解析测试（Sprint 30 增强）
 * 覆盖：每 N 分钟/小时、每天+时间、每周X、每月X号、时间词（下午/晚上 +12）、
 *       整点/半点/XX:XX、任务描述剥离、无效输入 null
 */

import { describe, it, expect } from "vitest";
import { parseNaturalSchedule, reconcileCron, stripScheduleWords } from "../src/core/nl-schedule.js";

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

  it("「每个周六」与「每周六」等价（个 前缀不再漏解析）", () => {
    const a = parseNaturalSchedule("每个周六，提醒我起立做运动");
    expect(a).toEqual({ cron: "0 0 * * 6", prompt: "提醒我起立做运动" });
    expect(parseNaturalSchedule("每周六，提醒我起立做运动")).toEqual(a);
  });

  it("「每个工作日 / 每个周末 / 每个小时 / 每个月」同样识别", () => {
    expect(parseNaturalSchedule("每个工作日9点提醒我")).toEqual({ cron: "0 9 * * 1-5", prompt: "提醒我" });
    expect(parseNaturalSchedule("每个周末10点整理相册")?.cron).toBe("0 10 * * 0,6");
    expect(parseNaturalSchedule("每个小时检查一次")?.cron).toBe("0 * * * *");
    expect(parseNaturalSchedule("每个月1号8点生成账单")?.cron).toBe("0 8 1 * *");
  });

  it("只命中时刻、星期词不被识别时也不静默降级成每天", () => {
    expect(parseNaturalSchedule("每逢周六下午3点提醒我锻炼")?.cron).toBe("0 15 * * 6");
  });

  it("任务正文里的星期词不覆盖已识别的频率", () => {
    expect(parseNaturalSchedule("每天9点提醒我周六有活动")?.cron).toBe("0 9 * * *");
  });

  it("剥离时间表达后清掉残留标点", () => {
    expect(stripScheduleWords("每周六，提醒我起立做运动").prompt).toBe("提醒我起立做运动");
    // 句尾标点不贴着被剥离片段 → 保留（避免吃掉任务名自带的标点，如 "检查 a.b."）
    expect(stripScheduleWords("每天10点提醒我。").prompt).toBe("提醒我。");
    expect(stripScheduleWords("提醒我运动")).toEqual({ prompt: "提醒我运动", matched: false });
  });

  it("reconcileCron：模型丢掉星期/时刻时按原句修回", () => {
    expect(reconcileCron("每个周六，提醒我起立做运动", "30 10 * * *")).toEqual({
      cron: "30 10 * * 6",
      notes: ["星期按原句改为 6"],
    });
    expect(reconcileCron("每天早上8点生成早报", "0 10 * * *").cron).toBe("0 8 * * *");
    expect(reconcileCron("每周一到周五9点签到", "0 10 * * *").cron).toBe("0 9 * * 1-5");
    expect(reconcileCron("每天10点提醒我运动", "0 10 * * 6").cron).toBe("0 10 * * *");
    expect(reconcileCron("提醒我运动", "30 10 * * *")).toEqual({ cron: "30 10 * * *", notes: [] });
    expect(reconcileCron("每隔一段时间提醒我", "not-a-cron")).toEqual({ cron: "not-a-cron", notes: [] });
  });

  it("「周天」出现在区间任一端都能识别（审核 F1）", () => {
    expect(parseNaturalSchedule("每周一到周天9点签到")?.cron).toBe("0 9 * * 1-7");
    // 反序区间在规则路径退回单日（周日），不生成 cron-parser 拒绝的 7-5
    expect(parseNaturalSchedule("每周天到周五9点签到")?.cron).toBe("0 9 * * 0");
  });

  it("反序星期区间不产生无效 cron、也不误改模型结果（审核 F1）", () => {
    const r = reconcileCron("每逢周天到周五提醒我锻炼", "0 9 * * 5");
    expect(r.cron).toBe("0 9 * * 5");
    expect(r.notes).toEqual([]);
  });

  it("时刻线索不覆盖间隔字段（审核 F2：9点每30分钟）", () => {
    const r = reconcileCron("9点每30分钟提醒我喝水", "*/30 * * * *");
    expect(r.cron).toBe("*/30 * * * *");
    expect(r.notes.length).toBeGreaterThan(0);
    expect(r.notes.join()).toContain("保留模型给出的");
    // 具体值仍然会被原句时刻修正
    expect(reconcileCron("9点提醒我", "0 10 * * *").cron).toBe("0 9 * * *");
  });

  it("只在剥离片段贴边时清标点，任务名自带的结尾标点保留（审核 F7）", () => {
    expect(stripScheduleWords("每天9点检查 a.b.").prompt).toBe("检查 a.b.");
    expect(stripScheduleWords("每天9点，提醒我").prompt).toBe("提醒我");
    expect(stripScheduleWords("提醒我，每天9点").prompt).toBe("提醒我");
  });
});
