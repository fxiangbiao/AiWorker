/**
 * Screen 差分渲染单测 — 重点覆盖 resize（终端尺寸变化）后的清屏防重叠
 */

import { describe, it, expect } from "vitest";
import { Screen } from "../src/terminal/screen.js";

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
