/**
 * Sprint 45 output.ts 回合注入测试：
 * 注入后文本行/半行/工具事件落入 turn 块；flush 提交半行；fence 状态回合级 reset
 */

import { describe, it, expect } from "vitest";
import { StreamOutputRenderer } from "../src/terminal/output.js";
import { TurnView } from "../src/terminal/turn-view.js";

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("StreamOutputRenderer 回合注入（Sprint 45）", () => {
  it("注入后文本与半行进入 turn text 块，不写消息区/stdout", () => {
    const r = new StreamOutputRenderer();
    const v = new TurnView();
    v.start();
    r.setTurn(v);
    r.writeChunk("第一行\n第二行\n");
    r.writeChunk("未完");
    r.flush();
    const text = strip(v.renderRows().join("\n"));
    expect(text).toContain("第一行");
    expect(text).toContain("第二行");
    expect(text).toContain("未完"); // 半行经 flush 提交
    r.setTurn(null);
  });

  it("工具事件注入 → turn tool 块 running→done 原位", () => {
    const r = new StreamOutputRenderer();
    const v = new TurnView();
    v.start();
    r.setTurn(v);
    r.toolStart("fs_read", '{"path":"/x"}', "t1");
    expect(strip(v.renderRows().join("\n"))).toContain("🔧 fs_read");
    expect(strip(v.renderRows().join("\n"))).not.toContain("✓");
    r.toolResult("fs_read", true, "内容", "t1");
    const done = strip(v.renderRows().join("\n"));
    expect(done).toContain("✓");
    // 工具行先于文本行（回合内事件序）
    r.writeChunk("总结\n");
    const all = strip(v.renderRows().join("\n"));
    expect(all.indexOf("🔧 fs_read")).toBeLessThan(all.indexOf("总结"));
    r.setTurn(null);
  });

  it("ask_user 注入 → turn ask 块（选项入块，无工具块）", () => {
    const r = new StreamOutputRenderer();
    const v = new TurnView();
    v.start();
    r.setTurn(v);
    r.toolStart("ask_user", JSON.stringify({ question: "继续吗？", options: ["继续", "停止"], multiple: false }), "a1");
    const text = strip(v.renderRows().join("\n"));
    expect(text).toContain("继续吗？");
    expect(text).toContain("1) 继续");
    expect(text).not.toContain("🔧 ask_user");
    r.setTurn(null);
  });

  it("writeChunk + flush 后残行不重复（lastPartial 清除，防重复渲染）", () => {
    const r = new StreamOutputRenderer();
    const v = new TurnView();
    v.start();
    r.setTurn(v);
    // 流式含换行：次行先作为半行进入 lastPartial，flush 时提交为成品行
    r.writeChunk("第一行\n第二行");
    r.flush();
    r.setTurn(null);
    const t = strip(v.renderRows().join("\n"));
    expect((t.match(/第一行/g) || []).length).toBe(1);
    expect((t.match(/第二行/g) || []).length).toBe(1);
  });

  it("注入新回合时 fence/table/半行状态重置（防跨回合残留）", () => {
    const r = new StreamOutputRenderer();
    const v1 = new TurnView();
    v1.start();
    r.setTurn(v1);
    r.writeChunk("```js\n"); // 开启 fence（未闭合）
    r.writeChunk("code");
    r.flush(); // flush 补底框
    r.setTurn(null);

    const v2 = new TurnView();
    v2.start();
    r.setTurn(v2); // 重置 fence
    r.writeChunk("正常文本行\n");
    const text = strip(v2.renderRows().join("\n"));
    expect(text).toContain("正常文本行");
    expect(text).not.toContain("code"); // 前一回合内容未残留
    r.setTurn(null);
  });
});
