/**
 * Sprint 45 MessageList 条目化回归测试：
 * 静态行行为与旧实现等价（append/setPartial/appendInline/setLine/滚动）、
 * 回合条目展开渲染与折叠行数变化、条目上限裁剪、空行顺序
 */

import { describe, it, expect } from "vitest";
import { MessageList } from "../src/terminal/components.js";
import { TurnView } from "../src/terminal/turn-view.js";

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("MessageList 条目化（Sprint 45）", () => {
  it("静态行流式语义等价：append 替换 partial 半行", () => {
    const m = new MessageList();
    m.append("第一行");
    m.setPartial("半行…");
    m.append("提交行");
    const rows = m.renderViewport(100, 10).map(strip);
    expect(rows[0]).toBe("第一行");
    expect(rows[1]).toBe("提交行"); // 半行被替换
    expect(rows).not.toContain("半行…");
  });

  it("appendInline 拼接与换行拆分", () => {
    const m = new MessageList();
    m.append("头");
    m.appendInline("身1\n身2");
    const rows = m.renderViewport(100, 10).map(strip).filter((l) => l !== "");
    expect(rows).toEqual(["头身1", "身2"]);
  });

  it("空行总是追加（分隔用）", () => {
    const m = new MessageList();
    m.append("a");
    m.append("");
    m.append("b");
    const rows = m.renderViewport(100, 10).map(strip);
    expect(rows[0]).toBe("a");
    expect(rows[1]).toBe("");
    expect(rows[2]).toBe("b");
  });

  it("回合条目：折叠 thinking 只占标题行；展开后行数增加；文本顺序在回合内容之后", () => {
    const m = new MessageList();
    const v = new TurnView();
    v.start();
    m.append("用户提问");
    m.appendTurn(v);
    v.thinkingDelta("思考内容\n第二行");
    m.append("回合后空行");

    const collapsed = m.renderViewport(100, 20).map(strip).filter((l) => l !== "");
    // 用户行 + thinking 标题 + 空行
    expect(collapsed[0]).toBe("用户提问");
    expect(collapsed[1]).toContain("思考");
    expect(collapsed[collapsed.length - 1]).toBe("回合后空行");

    // 展开 thinking → 行数增加且正文可见
    const t = v.foldTargets()[0]!;
    v.toggleById(t.id);
    const expanded = m.renderViewport(100, 20).map(strip).filter((l) => l !== "");
    expect(expanded.length).toBeGreaterThan(collapsed.length);
    expect(expanded.join("\n")).toContain("第二行");
    // 回合后空行仍在其后
    expect(expanded[expanded.length - 1]).toBe("回合后空行");
  });

  it("滚动 offset 钳制在视口内（offset 大 = 看历史顶）", () => {
    const m = new MessageList();
    for (let i = 0; i < 60; i++) m.append(`行${i}`);
    m.scroll(1000);
    const rows = m.renderViewport(100, 10).map(strip);
    expect(rows.length).toBe(10);
    expect(rows[0]).toBe("行0"); // 历史顶
    m.scrollToBottom();
    const bottom = m.renderViewport(100, 10).map(strip);
    expect(bottom[bottom.length - 1]).toBe("行59");
  });

  it("getTotalLines/setLine 只作用于静态行条目（legacy 语义）", () => {
    const m = new MessageList();
    m.append("a");
    const v = new TurnView();
    v.start();
    m.appendTurn(v);
    m.append("b");
    expect(m.getTotalLines()).toBe(2); // turn 不计
    m.setLine(1, "b2");
    const rows = m.renderViewport(100, 10).map(strip).filter((l) => l !== "");
    expect(rows).toContain("b2");
  });

  it("折行保留行首悬挂边界（长行 ├ │ gutter 不中断）", () => {
    const m = new MessageList();
    // 模拟 thinking 正文 gutter：长行折行后每段都应重放 `  │ ` 前缀（竖线不中断）
    const long = "  │ " + Array.from({ length: 60 }, (_, i) => `词${i}`).join(" ");
    m.append(long);
    const rows = m.renderViewport(20, 40).map(strip).filter((l) => l !== "");
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(r.startsWith("  │ ")).toBe(true);
  });

  it("无 gutter 的普通长行折行不额外加前缀（不改变原有换行语义）", () => {
    const m = new MessageList();
    m.append("The quick brown fox jumps over the lazy dog again and again");
    const rows = m.renderViewport(20, 40).map(strip).filter((l) => l !== "");
    expect(rows.length).toBeGreaterThan(1);
    // 首行不含前置空格；各段均为原始内容切分
    for (const r of rows) expect(r === r.trimStart()).toBe(true);
  });

  it("条目上限裁剪：保留尾部（整条目移除）", () => {
    const m = new MessageList();
    const total = 3100;
    for (let i = 0; i < total; i++) m.append(String(i));
    const rows = m.renderViewport(100, 8).map(strip);
    expect(rows).toContain(String(total - 1));
    expect(rows.join("\n")).not.toContain("0\n"); // 头部已裁
  });
});
