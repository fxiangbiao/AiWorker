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
  parseOptionInput,
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

  it("requestAsk 透传 multiple 到 provider", async () => {
    const captured: Array<{ multiple?: boolean }> = [];
    setAskProvider(async (req) => {
      captured.push(req);
      return "ok";
    });
    await requestAsk("q", ["a", "b"], true);
    await requestAsk("q", ["a", "b"]);
    expect(captured[0]!.multiple).toBe(true);
    expect(captured[1]!.multiple).toBe(false);
  });

  it("parseOptionInput：多选序号列表解析", () => {
    const options = ["竞技类", "单机大作", "休闲类", "什么都玩"];
    // 单选序号
    expect(parseOptionInput("2", options, false)).toBe("单机大作");
    // 多选：逗号分隔
    expect(parseOptionInput("1,3", options, true)).toBe("竞技类, 休闲类");
    // 多选：空格/顿号/中文逗号混合
    expect(parseOptionInput("1 4", options, true)).toBe("竞技类, 什么都玩");
    expect(parseOptionInput("1、2，4", options, true)).toBe("竞技类, 单机大作, 什么都玩");
    // 越界序号过滤
    expect(parseOptionInput("2,9", options, true)).toBe("单机大作");
    // 含非数字 → 视为自由文本
    expect(parseOptionInput("竞技类、休闲", options, true)).toBe("竞技类、休闲");
    // 单选模式下多序号不解析（按自由文本）
    expect(parseOptionInput("1,3", options, false)).toBe("1,3");
  });
});
