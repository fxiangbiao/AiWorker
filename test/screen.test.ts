/**
 * Screen 差分渲染单测 — 重点覆盖 resize（终端尺寸变化）后的清屏防重叠
 */

import { describe, it, expect } from "vitest";
import { Screen } from "../src/terminal/screen.js";
import { MessageList } from "../src/terminal/components.js";
import { displayWidth, truncateToWidth } from "../src/terminal/markdown.js";

function createScreen() {
  const out: string[] = [];
  const screen = new Screen((s) => out.push(s));
  return { screen, out };
}

describe("Screen 差分渲染", () => {
  it("首帧清屏后全量输出（含 2J 与逐行 2K）", () => {
    const { screen, out } = createScreen();
    screen.init();
    out.length = 0;
    screen.render(["line-a", "line-b"]);
    const all = out.join("");
    expect(all).toContain("\x1b[2J"); // 清屏
    expect(all).toContain("\x1b[2Kline-a"); // 逐行擦除防行尾残留
    expect(all).toContain("\x1b[2Kline-b");
  });

  it("resize 后重新清屏（防终端变窄/变矮时旧帧残留重叠）", () => {
    const { screen, out } = createScreen();
    screen.init();
    screen.render(["a"]);
    out.length = 0;

    // 普通差分渲染：不触发清屏
    screen.render(["b"]);
    expect(out.join("")).not.toContain("\x1b[2J");

    // resize（prev 清空）后走首帧路径 → 必须清屏
    out.length = 0;
    screen.resize();
    screen.render(["c"]);
    const all = out.join("");
    expect(all).toContain("\x1b[2J");
    expect(all).toContain("\x1b[2Kc");
  });

  it("差分渲染只输出变化行且逐行清行", () => {
    const { screen, out } = createScreen();
    screen.init();
    screen.render(["a", "b", "c"]);
    out.length = 0;
    screen.render(["a", "B", "c"]);
    const all = out.join("");
    expect(all).toContain("\x1b[2;1H\x1b[2K"); // 仅第 2 行变化
    expect(all).not.toContain("\x1b[1;1H");
    expect(all).not.toContain("\x1b[3;1H");
  });
});

describe("OSC 8 超链接与渲染完整性（Sprint 28 缺陷回归）", () => {
  const url = "https://example.com/game-design-resources-and-assets-pack-v2";
  const label = "未处理事件「%s」";
  const oscLine = `  \x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\ 其余内容：和解让共同熟 ${"x".repeat(120)}`;

  it("wrap 超长 OSC 8 行：完整链接保留在单行内且全部配对", () => {
    const list = new MessageList();
    list.append(oscLine);
    const viewport = list.renderViewport(60, 20);
    expect(viewport.some((l) => l.includes(`\x1b]8;;${url}\x1b\\`))).toBe(true);
    for (const l of viewport) {
      const open = (l.match(/\x1b\]8;/g) ?? []).length;
      const close = (l.match(/\x1b\\/g) ?? []).length;
      expect(open).toBe(close);
    }
  });

  it("resetLine 兜底：未闭合 OSC 8 行补 ST 关闭，不吞后续 ANSI", () => {
    const { screen, out } = createScreen();
    screen.init();
    out.length = 0;
    screen.render([`\x1b]8;;http://x.com\x1b\\text\x1b]8;;tail`]);
    const all = out.join("");
    expect(all).toContain("\x1b\\\x1b[0m"); // ST 先于 SGR reset
  });

  it("displayWidth / truncateToWidth 对 OSC 8 行按可见文本计算", () => {
    const visible = displayWidth(`\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\ xx`);
    expect(visible).toBe(displayWidth(label) + 3);
    const truncated = truncateToWidth(`\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\ xx`, 10);
    expect(truncated.includes("\x1b]8;")).toBe(false); // 截断剥除序列，无残留
  });
});
