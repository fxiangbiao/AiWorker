/**
 * Sprint 45 tui 回合生命周期/折叠键/ask 块/浏览模式 数据层测试
 * 不 init 终端（raw mode 不可用环境）：驱动公开方法与 simulateKey，断言消息区/回合/输入数据
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Tui } from "../src/terminal/tui.js";
import type { KeyEvent } from "../src/terminal/term.js";

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function key(ev: KeyEvent) {
  return ev;
}

/** 测试用：注入私有交互状态（未 init 终端的场景） */
function force<T>(obj: T, patch: Partial<T>): void {
  Object.assign(obj as object, patch);
}

describe("Tui 回合交互（Sprint 45）", () => {
  let t: Tui;
  beforeEach(() => {
    t = new Tui();
  });

  it("startTurn→finishTurn 生命周期：meta 入回合、结构保留供回看", () => {
    t.startTurn();
    const v = t.currentTurnView()!;
    v.thinkingDelta("思考摘要内容");
    v.addTool("c1", "fs_read", "f", "{}");
    v.textLine("回答文本");
    t.finishTurn("[迭代: 2]", { interrupted: false });
    expect(t.currentTurnView()).toBeNull();
    const saved = t.messages.lastTurnView()!;
    expect(saved).toBe(v);
    const rows = strip(saved.renderRows().join("\n"));
    expect(rows).toContain("回答文本");
    expect(rows).toContain("[迭代: 2]");
  });

  it("running 期间 appendMessage 重定向进回合 raw；定稿后回静态行", () => {
    t.startTurn();
    t.currentTurnView()!.thinkingDelta("思考");
    t.appendMessage("外部日志");
    expect(strip(t.currentTurnView()!.renderRows().join("\n"))).toContain("外部日志");
    // 定稿后 appendMessage 不再进回合
    t.finishTurn("");
    const before = strip(t.messages.lastTurnView()!.renderRows().join("\n"));
    t.appendMessage("回合后静态行");
    expect(strip(t.messages.lastTurnView()!.renderRows().join("\n"))).toBe(before);
    const all = t.messages.renderViewport(200, 30).map(strip).filter((l) => l !== "");
    expect(all[all.length - 1]).toBe("回合后静态行");
  });

  it("运行期折叠键：t 切换最近思考、c 全收（当前回合）", () => {
    t.startAgentSession(); // agentRunning=true
    t.startTurn();
    const v = t.currentTurnView()!;
    v.thinkingDelta("第一段思考\n第二行");
    expect(v.renderRows().length).toBe(1); // 默认折叠
    t.simulateKey(key({ type: "char", char: "t" }));
    expect(v.renderRows().length).toBeGreaterThan(1); // 展开
    t.simulateKey(key({ type: "char", char: "c" }));
    expect(v.renderRows().length).toBe(1); // 收起
    t.endAgentSession();
  });

  it("运行期 [ ] 在当前回合焦点环移动", () => {
    t.startAgentSession();
    t.startTurn();
    const v = t.currentTurnView()!;
    v.thinkingDelta("A 思考");
    v.addTool("c1", "fs_list", "", "{}");
    v.thinkingDelta("B 思考");
    t.simulateKey(key({ type: "char", char: "]" }));
    // 无焦点 → 最近 thinking（B）；再次 ] → 环到 A 之前是 tool…
    expect(v.focusId).toBe(v.foldTargets().filter((x) => x.kind === "thinking").at(-1)!.id);
    t.simulateKey(key({ type: "char", char: "[" }));
    // A → tool → B 共 3 个折叠目标；从 B 回退到 tool
    const targets = v.foldTargets();
    const toolId = targets.find((x) => x.kind === "tool")!.id;
    expect(v.focusId).toBe(toolId);
    t.endAgentSession();
  });

  it("ask 块模式：选项交互后结算压缩为一行", async () => {
    t.startTurn();
    const p = t.ask("是否继续？", ["继续", "停止"], 30000, false);
    const v = t.currentTurnView()!;
    const pending = strip(v.renderRows().join("\n"));
    expect(pending).toContain("是否继续？");
    expect(pending).toContain("1) 继续");
    // 高亮下移 → 单选空 Enter 提交高亮项
    t.simulateKey(key({ type: "down" }));
    t.simulateKey(key({ type: "enter" }));
    expect(await p).toBe("停止");
    const settled = strip(v.renderRows().join("\n"));
    expect(settled).toContain("回答: 停止");
    // 不再有可选项行
    expect(settled).not.toContain("1) 继续");
  });

  it("空闲浏览模式：[/] 移动跨回合焦点、t 折叠、Esc 退出、字符恢复输入", () => {
    t.startAgentSession();
    t.startTurn();
    const v1 = t.currentTurnView()!;
    v1.thinkingDelta("历史回合思考");
    v1.textLine("回合一回答");
    t.finishTurn("");
    t.endAgentSession();

    // 第二个回合
    t.startTurn();
    const v2 = t.currentTurnView()!;
    v2.thinkingDelta("第二回合思考");
    v2.textLine("回合二回答");
    t.finishTurn("");
    t.endAgentSession();

    // 空闲导航：需要 promptActive
    force(t, { promptActive: true, promptResolve: () => {} });
    expect(t.messages.foldableBlocks().length).toBe(2);

    // 输入为空 → → 定位最近 thinking（v2）
    t.simulateKey(key({ type: "right" }));
    expect(v2.focusId).not.toBeNull();
    // Enter：折叠/展开焦点块 → v2 展开
    t.simulateKey(key({ type: "enter" }));
    expect(v2.renderRows().length).toBeGreaterThan(1);
    // Esc：清除焦点高亮
    t.simulateKey(key({ type: "escape" }));
    expect(v2.focusId).toBeNull();
    // 字母输入不误触发折叠：输入 'a' 进输入行
    t.simulateKey(key({ type: "char", char: "a" }));
    expect(t.input.getValue()).toBe("a");
    // 输入非空时方向键不再触发导航/折叠
    const before = v2.renderRows().length;
    t.simulateKey(key({ type: "right" }));
    expect(v2.renderRows().length).toBe(before);
  });

  it("运行期 t 折叠当前回合（输入被忽略，无冲突）", () => {
    t.startAgentSession();
    t.startTurn();
    const v = t.currentTurnView()!;
    v.thinkingDelta("第一段思考\n第二行");
    expect(v.renderRows().length).toBe(1);
    t.simulateKey(key({ type: "char", char: "t" }));
    expect(v.renderRows().length).toBeGreaterThan(1);
    t.simulateKey(key({ type: "char", char: "c" }));
    expect(v.renderRows().length).toBe(1);
    t.endAgentSession();
  });
});
