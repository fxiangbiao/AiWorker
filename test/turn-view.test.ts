/**
 * Sprint 45 turn-view 块模型测试：
 * 事件→块序、thinking 折叠/摘要/字数、tool 原位终态、折叠切换、预算截断、
 * 焦点环、ask 交互终态、定稿（正常/中断）、raw/meta 顺序
 */

import { describe, it, expect } from "vitest";
import { TurnView } from "../src/terminal/turn-view.js";

/** 剥 ANSI 便于断言内容 */
function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function rows(v: TurnView): string[] {
  return v.renderRows().map(strip);
}

describe("TurnView 块模型（Sprint 45）", () => {
  it("事件序列 → 块序：thinking→tool→thinking→text 按到达序渲染", () => {
    const v = new TurnView();
    v.start();
    v.thinkingDelta("第一轮思考");
    v.addTool("c1", "fs_read", "x", "{}");
    v.toolResult("c1", true, "ok", "full", 1200);
    v.thinkingDelta("第二轮思考");
    v.textLine("这是回答");
    v.finish("[迭代: 3]", false);

    const r = rows(v);
    expect(r.join("\n")).toContain("思考");
    expect(r.join("\n")).toContain("🔧 fs_read");
    expect(r.join("\n")).toContain("这是回答");
    expect(r.join("\n")).toContain("[迭代: 3]");
    // 块序：思考标题在工具前、第二轮思考标题在文本前
    expect(r.findIndex((l) => l.includes("思考"))).toBeLessThan(r.findIndex((l) => l.includes("🔧")));
    expect(r.findIndex((l) => l.includes("第二轮"))).toBeLessThan(r.findIndex((l) => l.includes("这是回答")));
  });

  it("thinking 默认折叠：仅标题行；delta 刷新摘要与字数；展开后出正文", () => {
    const v = new TurnView();
    v.start();
    v.thinkingDelta("分析一下问题的本质\n然后给出方案");
    // 折叠：标题含摘要首段截断 + 字数
    let r = rows(v);
    expect(r.length).toBe(1);
    expect(r[0]).toContain("分析一下问题的本质");
    expect(r[0]).toMatch(/已 \d+ 字/);

    // 展开：正文行出现
    v.toggleById(v.foldTargets()[0]!.id);
    r = rows(v);
    expect(r.length).toBeGreaterThanOrEqual(3); // 标题 + 正文 2 行
    expect(r.join("\n")).toContain("然后给出方案");

    // 折叠回去：只剩标题
    v.toggleById(v.foldTargets()[0]!.id);
    r = rows(v);
    expect(r.length).toBe(1);
  });

  it("展开态 thinking 增量续写不丢内容（行缓存增量）", () => {
    const v = new TurnView();
    v.start();
    v.thinkingDelta("开头\n中段");
    v.toggleById(v.foldTargets()[0]!.id); // 展开
    v.thinkingDelta("\n结尾");
    const r = rows(v);
    expect(r.join("\n")).toContain("结尾");
  });

  it("tool running→done 状态原位更新（含耗时）与详情折叠", () => {
    const v = new TurnView();
    v.start();
    v.addTool("c1", "terminal_exec", "ls", '{"cmd":"ls"}');
    const running = rows(v).join("\n");
    expect(running).toContain("🔧 terminal_exec");
    expect(running).not.toContain("✓");

    v.toolResult("c1", true, "ok", "file1\nfile2", 2345);
    const done = rows(v).join("\n");
    expect(done).toContain("✓");
    expect(done).toContain("2.3s");

    // 详情展开
    const id = v.foldTargets().find((t) => t.kind === "tool")!.id;
    v.toggleById(id);
    const detail = rows(v).join("\n");
    expect(detail).toContain("参数:");
    expect(detail).toContain("file1");
  });

  it("超长 thinking 展开按预算截断并标注省略", () => {
    const v = new TurnView();
    v.start();
    v.thinkingDelta(Array.from({ length: 2000 }, (_, i) => `第${i}行`).join("\n"));
    v.toggleById(v.foldTargets()[0]!.id);
    const r = rows(v);
    // 标题 + 省略标注 + 尾部预算行（≤ 约 400 行）
    expect(r.length).toBeLessThan(450);
    expect(r.join("\n")).toContain("已省略");
  });

  it("焦点环：moveFocus/toggle 快捷键语义（t=最近 thinking）", () => {
    const v = new TurnView();
    v.start();
    v.thinkingDelta("A 思考");
    v.addTool("c1", "fs_list", "", "{}");
    v.thinkingDelta("B 思考");

    const targets = v.foldTargets();
    expect(targets.map((t) => t.kind)).toEqual(["thinking", "tool", "thinking"]);

    // t：折叠/展开最近 thinking（B）
    v.toggleThinking();
    expect(targets[2]!.kind).toBe("thinking");
    const bOpen = rows(v).length > 1;
    expect(bOpen).toBe(true);

    // [ ] 环：无焦点时优先最近 thinking（B），再前移到 A
    const t1 = v.moveFocus(1);
    expect(t1!.kind).toBe("thinking");
    const t2 = v.moveFocus(1);
    expect(t2!.kind).toBe("thinking");
    expect(t2!.id).toBe(targets[0]!.id); // 绕回第一个 thinking（A）

    // o：最近 tool 详情
    v.toggleToolDetail();
    const toolId = targets.find((t) => t.kind === "tool")!.id;
    expect(rows(v).join("\n")).toContain("参数:");
    void toolId;
  });

  it("collapseAll/expandAll", () => {
    const v = new TurnView();
    v.start();
    v.thinkingDelta("长思考" + "x".repeat(100));
    v.addTool("c1", "web", "", "{}");
    v.thinkingDelta("再次思考" + "y".repeat(100));
    v.expandAll();
    expect(rows(v).length).toBeGreaterThan(4);
    v.collapseAll();
    // 只剩 2 个 thinking 标题 + 1 个 tool 标题
    expect(rows(v).length).toBe(3);
  });

  it("ask 块：pending 交互行 → answered/timeout/canceled 压缩为一行", () => {
    const v = new TurnView();
    v.start();
    v.addAsk("是否继续？", ["继续", "停止"], false);
    let r = rows(v);
    expect(r.join("\n")).toContain("是否继续？");
    expect(r.join("\n")).toContain("1) 继续");

    // 高亮移动
    v.askUpdate({ highlight: 1 });
    r = rows(v);
    expect(r.join("\n")).toContain(">");

    v.finishAsk("继续", "answered");
    r = rows(v);
    expect(r.length).toBe(1);
    expect(r.join("\n")).toContain("回答: 继续");

    // timeout / canceled 形态
    const v2 = new TurnView();
    v2.start();
    v2.addAsk("等等？", [], false);
    v2.finishAsk(null, "timeout");
    expect(rows(v2).join("\n")).toContain("超时未答");
    const v3 = new TurnView();
    v3.start();
    v3.addAsk("等等？", [], false);
    v3.finishAsk(null, "canceled");
    expect(rows(v3).join("\n")).toContain("已取消");
  });

  it("定稿（正常/中断）：running tool 置 error、thinking 关闭、meta 与 running 状态", () => {
    const v = new TurnView();
    v.start();
    v.thinkingDelta("思考中");
    v.addTool("c1", "fs_write", "f", "{}");
    expect(v.isRunning()).toBe(true);

    v.finish("[已中断]", true);
    expect(v.isRunning()).toBe(false);
    expect(v.interrupted).toBe(true);
    const r = rows(v).join("\n");
    expect(r).toContain("已中断"); // tool running → error 预览
    expect(r).toContain("[已中断]"); // meta
  });

  it("text 半行（lastPartial）与 flush 提交；raw 渲染于事件块之后、meta 之前", () => {
    const v = new TurnView();
    v.start();
    v.textPartial("半个词");
    expect(rows(v).join("\n")).toContain("半个词");
    v.textPartial("半个词组");
    v.textCommit();
    v.addRaw("后台日志行");
    v.finish("[meta]", false);
    const r = rows(v);
    expect(r.join("\n")).toContain("后台日志行");
    const idxLog = r.findIndex((l) => l.includes("后台日志行"));
    const idxText = r.findIndex((l) => l.includes("半个词组"));
    const idxMeta = r.findIndex((l) => l.includes("[meta]"));
    expect(idxLog).toBeGreaterThan(idxText);
    expect(idxMeta).toBeGreaterThan(idxLog);
  });

  it("start 重置：多次回合复用同一 TurnView 不残留", () => {
    const v = new TurnView();
    v.start();
    v.thinkingDelta("第一回合");
    v.finish("[1]", false);
    v.start();
    v.thinkingDelta("第二回合");
    const r = rows(v).join("\n");
    expect(r).not.toContain("第一回合");
    expect(r).toContain("第二回合");
  });
});
