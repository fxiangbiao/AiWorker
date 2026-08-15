/**
 * 提问通道（ask_user）单测（Sprint 26）
 * 覆盖：provider 路由、SSE 挂起响应、超时返回 null、未知 id 404
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  setAskProvider,
  createHttpAskProvider,
  askResponse,
  requestAsk,
  isAskWaiting,
} from "../src/tools/ask-channel.js";

afterEach(() => {
  setAskProvider(null);
});

describe("ask-channel", () => {
  it("注册 provider 后 requestAsk 走 provider", async () => {
    const sent: { id: string; question: string; options: string[] }[] = [];
    setAskProvider(async (req) => {
      sent.push(req);
      return "42";
    });
    const answer = await requestAsk("1+1=?", ["1", "2", "3"]);
    expect(answer).toBe("42");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.question).toBe("1+1=?");
    expect(sent[0]!.options).toEqual(["1", "2", "3"]);
  });

  it("createHttpAskProvider 挂起等待 askResponse 精确路由", async () => {
    const sent: { id: string; question: string }[] = [];
    const provider = createHttpAskProvider((req) => sent.push({ id: req.id, question: req.question }), 2000);

    const p1 = provider({ id: "ask-1", question: "继续吗？", options: ["是", "否"] });
    const p2 = provider({ id: "ask-2", question: "选哪个？", options: ["A", "B"] });
    expect(sent).toHaveLength(2);

    expect(askResponse("ask-2", "B")).toBe(true);
    expect(askResponse("ask-1", "是")).toBe(true);
    expect(await p1).toBe("是");
    expect(await p2).toBe("B");
  });

  it("超时返回 null（fail-safe）", async () => {
    const provider = createHttpAskProvider(() => {}, 50);
    const start = Date.now();
    const result = await provider({ id: "ask-t", question: "q", options: [] });
    expect(result).toBeNull();
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  it("未知 id 的 askResponse 返回 false", () => {
    expect(askResponse("nope", "x")).toBe(false);
  });

  it("重复响应同一 id：第二次返回 false", async () => {
    const provider = createHttpAskProvider(() => {}, 2000);
    const p = provider({ id: "ask-d", question: "q", options: [] });
    expect(askResponse("ask-d", "ok")).toBe(true);
    expect(askResponse("ask-d", "again")).toBe(false);
    expect(await p).toBe("ok");
  });

  it("isAskWaiting：提问挂起期间 true，结束后 false（TUI 状态栏用）", async () => {
    let resolveAsk: (v: string | null) => void = () => {};
    setAskProvider(() => new Promise<string | null>((r) => { resolveAsk = r; }));
    expect(isAskWaiting()).toBe(false);

    const p = requestAsk("继续吗？");
    // 让 requestAsk 内的置位逻辑执行
    await new Promise((r) => setTimeout(r, 10));
    expect(isAskWaiting()).toBe(true);

    resolveAsk("是");
    await p;
    expect(isAskWaiting()).toBe(false);
  });

  it("isAskWaiting：超时/异常后复位为 false", async () => {
    setAskProvider(async () => null); // 立即返回
    await requestAsk("q");
    expect(isAskWaiting()).toBe(false);
  });
});
