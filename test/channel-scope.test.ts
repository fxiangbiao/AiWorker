/**
 * 无确认通道作用域测试（Sprint 52 收尾）
 * 覆盖：作用域内 confirm/ask 立即 fail-closed；作用域外（父会话）通道不受影响；并发互不干扰
 */

import { describe, it, expect, afterEach } from "vitest";
import { runWithoutChannel, isChannelSuppressed } from "../src/hooks/channel-scope.js";
import { requestConfirm, setConfirmProvider } from "../src/hooks/confirm-channel.js";
import { requestAsk, setAskProvider } from "../src/tools/ask-channel.js";

const allowOptions = [{ value: "allow", label: "允许" }];

describe("channel-scope（无确认通道作用域）", () => {
  const restores: Array<() => void> = [];

  afterEach(() => {
    while (restores.length > 0) restores.pop()!();
  });

  function installProviders(): void {
    const prevConfirm = setConfirmProvider(async () => "allow");
    const prevAsk = setAskProvider(async () => "父会话回答");
    restores.push(() => setConfirmProvider(prevConfirm));
    restores.push(() => setAskProvider(prevAsk));
  }

  it("作用域内 confirm/ask 立即返回 null（fail-closed，不落 stdin）", async () => {
    installProviders();
    const inside = await runWithoutChannel(async () => {
      expect(isChannelSuppressed()).toBe(true);
      return [await requestConfirm("危险操作？", allowOptions), await requestAsk("提问", [], false)];
    });
    expect(inside).toEqual([null, null]);
    expect(isChannelSuppressed()).toBe(false);
  });

  it("作用域外的父会话通道不受影响", async () => {
    installProviders();
    await runWithoutChannel(async () => {
      await requestConfirm("子智能体侧", allowOptions);
    });
    expect(await requestConfirm("父会话侧", allowOptions)).toBe("allow");
    expect(await requestAsk("父会话提问", [], false)).toBe("父会话回答");
  });

  it("并发：子智能体作用域挂起期间，父会话仍能拿到真实应答", async () => {
    installProviders();
    let releaseSubagent: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseSubagent = resolve;
    });
    const subagent = runWithoutChannel(async () => {
      await gate;
      return requestConfirm("子智能体侧", allowOptions);
    });
    // 子智能体的异步链仍在作用域内（挂起中），此刻父会话发起确认
    expect(await requestConfirm("父会话侧", allowOptions)).toBe("allow");
    releaseSubagent();
    expect(await subagent).toBeNull();
  });

  it("作用域内嵌套异步链（await 多次）保持抑制", async () => {
    installProviders();
    const result = await runWithoutChannel(async () => {
      await new Promise((r) => setTimeout(r, 5));
      const nested = async () => {
        await new Promise((r) => setTimeout(r, 5));
        return requestConfirm("深层", allowOptions);
      };
      return nested();
    });
    expect(result).toBeNull();
  });
});
