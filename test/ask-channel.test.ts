/**
 * 提问通道（ask_user）单测（Sprint 26）
 * 覆盖：provider 路由、SSE 挂起响应、超时返回 null、未知 id 404
 */

import { describe, it, expect, afterEach } from "vitest";
import { setAskProvider, createHttpAskProvider, askResponse, requestAsk } from "../src/tools/ask-channel.js";

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
});
