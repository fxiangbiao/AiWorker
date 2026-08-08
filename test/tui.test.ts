/**
 * TUI 引擎测试 — 帧合成 / 流式半行 / 滚动 / 输入解析
 * 不依赖真实 TTY：直接测组件与键解析纯逻辑。
 */

import { describe, it, expect } from "vitest";
import { MessageList, InputLine, StatusBar } from "../src/terminal/components.js";
import { parseKeys } from "../src/terminal/term.js";
import { renderMarkdown, charWidth } from "../src/terminal/markdown.js";

describe("MessageList 帧渲染", () => {
  it("append 追加行，renderViewport 取最后 height 行", () => {
    const ml = new MessageList();
    ml.append("a");
    ml.append("b");
    ml.append("c");
    const out = ml.renderViewport(10, 2);
    expect(out).toHaveLength(2);
    expect(out[0]!).toContain("b");
    expect(out[1]!).toContain("c");
  });

  it("不足 height 时补空行", () => {
    const ml = new MessageList();
    ml.append("x");
    const out = ml.renderViewport(10, 3);
    expect(out).toHaveLength(3);
    expect(out[0]!).toContain("x");
    expect(out[1]).toBe("");
    expect(out[2]).toBe("");
  });

  it("流式 setPartial 替换上一半行，append 提交", () => {
    const ml = new MessageList();
    ml.setPartial("hel");
    ml.setPartial("hello");
    const out1 = ml.renderViewport(30, 5);
    expect(out1[0]!).toContain("hello");
    // 提交完整行替换半行
    ml.append("hello world");
    const out2 = ml.renderViewport(30, 5);
    expect(out2[0]!).toContain("hello world");
    expect(out2[1]!).not.toContain("hel");
  });

  it("appendInline 追加到当前行", () => {
    const ml = new MessageList();
    ml.append("start");
    ml.appendInline("+");
    ml.appendInline("+");
    const out = ml.renderViewport(10, 5);
    expect(out[0]!).toContain("start++");
  });

  it("scroll 偏移后显示历史", () => {
    const ml = new MessageList();
    for (let i = 0; i < 10; i++) ml.append(`line${i}`);
    const out0 = ml.renderViewport(30, 3);
    expect(out0[2]!).toContain("line9");
    ml.scroll(3, 3);
    const out = ml.renderViewport(30, 3);
    expect(out[0]!).toContain("line4");
    expect(out[2]!).toContain("line6");
  });

  it("上滚到顶窗口仍填满，下滚可回到底部", () => {
    const ml = new MessageList();
    for (let i = 0; i < 10; i++) ml.append(`line${i}`);
    // 持续上滚到顶
    for (let i = 0; i < 10; i++) ml.scroll(3, 3);
    let out = ml.renderViewport(30, 3);
    // 窗口填满 3 行（不出现空行导致的"逐行消失"）
    expect(out.filter((l) => l !== "")).toHaveLength(3);
    expect(out[0]!).toContain("line0");
    // 下滚回到底部（显示恢复最新内容）
    for (let i = 0; i < 10; i++) ml.scroll(-3, 3);
    out = ml.renderViewport(30, 3);
    expect(out[2]!).toContain("line9");
    expect(out.filter((l) => l !== "")).toHaveLength(3);
  });

  it("超宽行自动换行（CJK）", () => {
    const ml = new MessageList();
    const wide = "│ 命令                 │ 功能                   │ 说明";
    ml.append(wide);
    const out = ml.renderViewport(30, 5);
    // 宽行应拆成多视觉行，每行 ≤ 30 显示宽
    expect(out.length).toBeGreaterThan(1);
    for (const row of out) {
      // eslint-disable-next-line no-control-regex
      const clean = row.replace(/\x1b\[\d+(;\d+)*m/g, "");
      expect(clean.length).toBeLessThanOrEqual(30);
    }
  });

  it("wrap 后行数计入 viewport 高度", () => {
    const ml = new MessageList();
    ml.append("short");
    ml.append("this is a very long line that will wrap into multiple rows of the viewport width");
    const out = ml.renderViewport(20, 10);
    // 第一行 + 第二行(拆成约 5 行) = 6 非空行
    const nonEmpty = out.filter((r) => r !== "");
    expect(nonEmpty.length).toBeGreaterThan(3);
  });
});

describe("InputLine 输入编辑", () => {
  it("type 插入 + 光标移动 + 退格", () => {
    const il = new InputLine();
    il.type("ab");
    expect(il.getValue()).toBe("ab");
    il.moveLeft();
    il.type("X");
    expect(il.getValue()).toBe("aXb");
    il.moveEnd();
    il.backspace();
    expect(il.getValue()).toBe("aX");
  });

  it("历史上翻/下翻", () => {
    const il = new InputLine();
    il.setHistory(["cmd1", "cmd2"]);
    il.type("new");
    il.historyUp();
    expect(il.getValue()).toBe("cmd2");
    il.historyUp();
    expect(il.getValue()).toBe("cmd1");
    il.historyDown();
    il.historyDown();
    expect(il.getValue()).toBe("new");
  });

  it("补全最长公共前缀", () => {
    const il = new InputLine();
    il.setCompleter((line) => ["/status", "/sessions", "/switch"].filter((c) => c.startsWith(line)));
    il.type("/s");
    il.complete();
    expect(il.getValue()).toBe("/s");
  });
});

describe("StatusBar 渲染", () => {
  it("包含模式与模型信息", () => {
    const sb = new StatusBar();
    sb.setData({ mode: "auto", model: "deepseek", tokensUsed: 1000, queueSize: 0 });
    const out = sb.render(80);
    expect(out[0]!).toContain("AUTO");
    expect(out[0]!).toContain("deepseek");
    expect(out[0]!).toContain("token");
  });

  it("windowPct 进度条", () => {
    const sb = new StatusBar();
    sb.setData({ mode: "auto", model: "m", tokensUsed: 0, queueSize: 0, windowPct: 65 });
    const out = sb.render(80);
    expect(out[0]!).toContain("%");
  });

  it("窄宽度下保留右侧帮助，压缩左侧", () => {
    const sb = new StatusBar();
    sb.setData({ mode: "auto", model: "very-long-model-name-xyz", tokensUsed: 9999, queueSize: 2, windowPct: 65 });
    const out = sb.render(60);
    // 右侧 help 完整可见
    // eslint-disable-next-line no-control-regex
    const clean = out[0]!.replace(/\x1b\[\d+(;\d+)*m/g, "");
    expect(clean).toContain("/help /thinking /exit");
    // 行不超宽
    expect(clean.length).toBeLessThanOrEqual(60);
  });

  it("80 列下完整显示右侧 help（含全角边框）", () => {
    const sb = new StatusBar();
    sb.setData({ mode: "auto", model: "deepseek-v4-flash", tokensUsed: 1700, queueSize: 0, windowPct: 3, status: "思考中" });
    const out = sb.render(80);
    // eslint-disable-next-line no-control-regex
    const clean = out[0]!.replace(/\x1b\[\d+(;\d+)*m/g, "");
    expect(clean).toContain("/help /thinking /exit");
    expect(clean).toContain("思考中");
    expect(clean.length).toBeLessThanOrEqual(80);
  });

  it("clearTransient 清除思考中/工具名", () => {
    const sb = new StatusBar();
    sb.setData({ mode: "auto", model: "m", tokensUsed: 0, queueSize: 0, status: "思考中", toolName: "fs_write" });
    const out1 = sb.render(80);
    expect(out1[0]!).toContain("思考中");
    sb.clearTransient();
    const out2 = sb.render(80);
    expect(out2[0]!).not.toContain("思考中");
    expect(out2[0]!).not.toContain("fs_write");
  });
});

describe("Markdown 块级渲染", () => {
  it("表格跨行对齐", () => {
    const md = "| 名称 | 数量 |\n|---|---:|\n| 苹果 | 3 |\n| 很长的名称 | 42 |";
    const out = renderMarkdown(md);
    // 4 行：表头 + 分隔线 + 2 数据行
    expect(out).toHaveLength(4);
    // 名称列左对齐：两数据行同列起点
    const colStart = (row: string) => {
      // eslint-disable-next-line no-control-regex
      const clean = row.replace(/\x1b\[\d+(;\d+)*m/g, "");
      return clean.indexOf("苹果") !== -1 ? clean.indexOf("苹果") : clean.indexOf("很长的名称");
    };
    const s1 = colStart(out[2]!);
    const s2 = colStart(out[3]!);
    expect(s1).toBe(s2);
  });

  it("无显式对齐行时不画表头分隔线", () => {
    const md = "| 命令 | 功能 |\n| /plan | 协作 |";
    const out = renderMarkdown(md);
    expect(out).toHaveLength(2); // 无分隔线
    // 无全角分隔线行（───┼───）
    // eslint-disable-next-line no-control-regex
    const joined = out.join("\n").replace(/\x1b\[\d+(;\d+)*m/g, "");
    expect(joined).not.toMatch(/─+┼/);
  });

  it("分隔线与数据行逐列对齐（内容完整不截断）", () => {
    const md = [
      "| 命令 | 功能 | 说明 |",
      "|---|---|---|",
      "| /plan <描述> | 多专家 DAG 协作 | 自动分解任务，拓扑序执行 |",
      "| /exit | 退出 |  |",
    ].join("\n");
    const out = renderMarkdown(md);
    // 表头 + 分隔线 + 2 数据行
    expect(out).toHaveLength(4);
    const clean = out.map((l) =>
      // eslint-disable-next-line no-control-regex
      l.replace(/\x1b\[\d+(;\d+)*m/g, ""),
    );
    // 所有行 │ 的显示列位置一致
    const colPos = (l: string) => {
      const idxs: number[] = [];
      let w = 0;
      for (const ch of l) {
        if (ch === "│") idxs.push(w);
        w += charWidth(ch);
      }
      return idxs.join(",");
    };
    const first = colPos(clean[0]!);
    for (const l of clean) expect(colPos(l)).toBe(first);
  });

  it("表格内容完整不截断（含长文本）", () => {
    const md =
      "| 命令 | 说明 |\n|---|---|\n| /mode <模式> | ask(只读) / plan(确认后执行) / Auto(自动执行) |";
    const out = renderMarkdown(md);
    // eslint-disable-next-line no-control-regex
    const clean = out.map((l) => l.replace(/\x1b\[\d+(;\d+)*m/g, ""));
    expect(clean.some((l) => l.includes("ask(只读)"))).toBe(true);
  });

  it("代码块保留左侧色条", () => {
    const out = renderMarkdown("```ts\nconst x = 1;\n```");
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(out[1]!).toContain("▍");
  });

  it("标题着色", () => {
    const out = renderMarkdown("# Title\n\n正文");
    expect(out[0]!).toContain("Title");
    expect(out[0]!).not.toContain("# "); // 已渲染，非原始 Markdown
    expect(out).toHaveLength(3);
  });
});

describe("键解析 parseKeys", () => {
  it("方向键经典 CSI", () => {
    const { events } = parseKeys("\x1b[A\x1b[B\x1b[C\x1b[D");
    expect(events.map((e) => e.type)).toEqual(["up", "down", "right", "left"]);
  });

  it("Home/End/Delete/PgUp/PgDn", () => {
    const { events } = parseKeys("\x1b[H\x1b[F\x1b[3~\x1b[5~\x1b[6~");
    expect(events.map((e) => e.type)).toEqual(["home", "end", "delete", "pageup", "pagedown"]);
  });

  it("Enter/Tab/退格/Ctrl+C", () => {
    const { events } = parseKeys("\r\t\x7f\x03");
    expect(events.map((e) => e.type)).toEqual(["enter", "tab", "backspace", "ctrlC"]);
  });

  it("可打印字符", () => {
    const { events } = parseKeys("你好abc");
    expect(events.filter((e) => e.type === "char").map((e) => (e as { char: string }).char)).toEqual([
      "你",
      "好",
      "a",
      "b",
      "c",
    ]);
  });

  it("SGR 鼠标滚轮：上滚=wheelup，下滚=wheeldown", () => {
    const { events } = parseKeys("\x1b[<64;10;20M\x1b[<65;10;20M");
    expect(events.map((e) => e.type)).toEqual(["wheelup", "wheeldown"]);
  });
});

describe("Tui 帧合成", () => {
  it("全帧包含消息区+输入行+状态栏", async () => {
    const { Tui } = await import("../src/terminal/tui.js");
    const t = new Tui();
    t.init(); // 非 TTY 降级但 active=true
    t.screen.setOut(() => {}); // 屏蔽真实输出
    t.messages.append("hello");
    t.input.type("hi");
    t.status.setData({ mode: "auto", model: "m", tokensUsed: 0, queueSize: 0 });
    t.requestRender();
    await new Promise((r) => setTimeout(r, 40));
    expect(t.messages.getTotalLines()).toBe(1);
    expect(t.input.getValue()).toBe("hi");
    t.destroy();
  });

  it("prompt 在 Enter 后 resolve 输入值", async () => {
    const { Tui } = await import("../src/terminal/tui.js");
    const t = new Tui();
    t.init(); // 非 TTY 环境：raw mode 降级但 active=true
    t.screen.setOut(() => {}); // init 后再屏蔽真实输出
    const p = t.prompt();
    // 模拟按键
    for (const ch of "hello") t.simulateKey({ type: "char", char: ch });
    t.simulateKey({ type: "enter" });
    const value = await p;
    expect(value).toBe("hello");
    t.destroy();
  });

  it("Enter 后提问内容追加到消息历史（你> 前缀）", async () => {
    const { Tui } = await import("../src/terminal/tui.js");
    const t = new Tui();
    t.init();
    t.screen.setOut(() => {});
    const p = t.prompt();
    for (const ch of "讲个笑话") t.simulateKey({ type: "char", char: ch });
    t.simulateKey({ type: "enter" });
    await p;
    expect(t.messages.getTotalLines()).toBe(1);
    const rendered = t.messages.renderViewport(80, 5);
    // eslint-disable-next-line no-control-regex
    const clean = rendered[0]!.replace(/\x1b\[\d+(;\d+)*m/g, "");
    expect(clean).toContain("你> 讲个笑话");
    t.destroy();
  });

  it("endAgentSession 追加空行分隔轮次", async () => {
    const { Tui } = await import("../src/terminal/tui.js");
    const t = new Tui();
    t.init();
    t.screen.setOut(() => {});
    t.messages.append("你> 问题");
    t.startAgentSession();
    t.messages.append("回答内容");
    t.endAgentSession();
    expect(t.messages.getTotalLines()).toBe(3); // 提问 + 回答 + 空行
    t.destroy();
  });

  it("endAgentSession 空行不覆盖流式半行（partial 内容保留）", async () => {
    const { Tui } = await import("../src/terminal/tui.js");
    const t = new Tui();
    t.init();
    t.screen.setOut(() => {});
    t.messages.append("你> 问题");
    t.startAgentSession();
    // 流式半行（未提交）
    t.messages.setPartial("URL: https://example.com/long");
    t.endAgentSession(); // 应追加空行而非替换半行
    expect(t.messages.getTotalLines()).toBe(3); // 提问 + 半行 + 空行
    const rendered = t.messages.renderViewport(80, 5);
    // eslint-disable-next-line no-control-regex
    const all = rendered.map((l) => l.replace(/\x1b\[\d+(;\d+)*m/g, "")).join("\n");
    expect(all).toContain("URL: https://example.com/long");
    t.destroy();
  });

  it("appendInline 含换行 chunk 拆分为多行，不破坏帧布局", async () => {
    const { Tui } = await import("../src/terminal/tui.js");
    const t = new Tui();
    t.init();
    t.screen.setOut(() => {});
    const rows = t.screen.getRows();
    const contentHeight = rows - 3;
    t.messages.append("你> 问题");
    // 模拟思考流式 chunk 含换行
    t.messages.appendInline("思考第一行\n思考第二行\n第三");
    const frame = t.messages.renderViewport(80, contentHeight);
    // eslint-disable-next-line no-control-regex
    const joined = frame.map((l) => l.replace(/\x1b\[\d+(;\d+)*m/g, "")).join("\n");
    expect(joined).toContain("思考第一行");
    expect(joined).toContain("思考第二行");
    expect(joined).toContain("第三");
    // 行数应恰好填满 contentHeight（不溢出顶掉分隔线/输入行）
    expect(frame).toHaveLength(contentHeight);
    t.destroy();
  });

  it("renderViewport 超宽行 wrap 后仍填满且不溢出（输入行不被顶掉）", async () => {
    const { Tui } = await import("../src/terminal/tui.js");
    const t = new Tui();
    t.init();
    t.screen.setOut(() => {});
    // 模拟消息区高度为 5（rows=8, 无 hint），输入行在第 6 行
    const rows = 8;
    const contentHeight = rows - 2;
    // 加入多个超宽行，wrap 后行数远超 contentHeight
    for (let i = 0; i < 3; i++) {
      t.messages.append("这是一段非常非常长的内容".repeat(10));
    }
    const msg = t.messages.renderViewport(40, contentHeight);
    expect(msg).toHaveLength(contentHeight); // 恰好填满，不溢出
    t.destroy();
  });

  it("滚动到顶部窗口仍填满，输入行稳定", async () => {
    const { Tui } = await import("../src/terminal/tui.js");
    const t = new Tui();
    t.init();
    t.screen.setOut(() => {});
    t.prompt();
    for (let i = 0; i < 40; i++) t.messages.append(`line${i}`);
    // 上滚多次到顶
    for (let i = 0; i < 20; i++) t.simulateKey({ type: "wheelup" });
    const msg = t.messages.renderViewport(80, t.screen.getRows() - 3);
    // 消息区填满，无空行（内容未消失）
    expect(msg.every((l) => l !== "")).toBe(true);
    t.destroy();
  });

  it("帧布局含分隔线：消息区 + 分隔线 + 输入行 + 状态栏", async () => {
    const { Tui } = await import("../src/terminal/tui.js");
    const t = new Tui();
    t.init();
    const out: string[] = [];
    t.screen.setOut((s) => out.push(s));
    t.messages.append("你> hi");
    t.prompt();
    t.requestRender();
    await new Promise((r) => setTimeout(r, 40));
    // 帧输出包含分隔线行（─ 序列）与输入行、状态栏
    const joined = out.join("");
    expect(joined).toContain("─");
    expect(joined).toContain("你> ");
    expect(joined).toContain("/help");
    t.destroy();
  });

  it("滚轮/方向键按输入框状态分流：空输入滚动屏幕，有输入切历史", async () => {
    const { Tui } = await import("../src/terminal/tui.js");
    const t = new Tui();
    t.init();
    t.screen.setOut(() => {});
    t.prompt();
    // 超过消息区可视高度，确保有滚动空间
    for (let i = 0; i < 40; i++) t.messages.append(`line${i}`);
    t.input.setHistory(["cmd1", "cmd2", "cmd3"]);

    // 空输入 + 上键 → 滚动消息（虚拟屏幕向上翻）
    t.simulateKey({ type: "up" });
    expect(t.messages.getScrollOffset()).toBeGreaterThan(0);
    // 空输入 + 下键 → 回到底部
    t.simulateKey({ type: "down" });
    t.simulateKey({ type: "down" });
    expect(t.messages.getScrollOffset()).toBe(0);

    // 有输入 + 上键 → 切换输入历史（不滚动消息）
    t.input.type("new");
    const offsetBefore = t.messages.getScrollOffset();
    t.simulateKey({ type: "up" });
    expect(t.input.getValue()).toBe("cmd3");
    expect(t.messages.getScrollOffset()).toBe(offsetBefore);
    t.destroy();
  });
});
