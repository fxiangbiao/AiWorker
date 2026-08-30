/**
 * 生成任务队列测试（Sprint 35 补丁）— 异步生成/取消/失败
 */

import { describe, it, expect, beforeEach } from "vitest";
import { GeneratorQueue } from "../src/core/generator-queue.js";
import type { AppFactory } from "../src/core/app-factory.js";
import type { AppSpec } from "../src/types.js";

const spec: AppSpec = { description: "番茄钟", type: "app" };

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("generator-queue 异步生成", () => {
  let q: GeneratorQueue;
  let release: () => void;

  beforeEach(() => {
    q = new GeneratorQueue();
    let resolveGen: () => void;
    release = () => resolveGen?.();
    q.init({
      generate: async (_spec, onProgress) => {
        onProgress?.("骨架", 1, 3);
        await new Promise<void>((r) => {
          resolveGen = () => r();
        });
        onProgress?.("逻辑", 2, 3);
        onProgress?.("样式", 3, 3);
        return { ok: true, app: { id: "gen-1", name: "x", version: "1.0.0", type: "app", status: "running" } };
      },
    } as unknown as AppFactory);
  });

  it("入队返回 jobId，状态流转 queued→running→done", async () => {
    const id = q.submit(spec);
    expect(id).toMatch(/^genjob-/);
    expect(q.get(id)?.status).toBe("running"); // 已开始（未 release，挂起中）
    release();
    await wait(50);
    expect(q.get(id)?.status).toBe("done");
    expect(q.get(id)?.result?.ok).toBe(true);
  });

  it("cancel 排队中任务 → canceled（首个占并发，第二个排队）", () => {
    const id1 = q.submit(spec);
    expect(q.get(id1)?.status).toBe("running"); // 第一个占并发（挂起）
    const id2 = q.submit(spec);
    expect(q.get(id2)?.status).toBe("queued"); // 第二个排队
    const ok = q.cancel(id2);
    expect(ok).toBe(true);
    expect(q.get(id2)?.status).toBe("canceled");
  });

  it("生成失败 → failed + error", async () => {
    const q2 = new GeneratorQueue();
    q2.init({
      generate: async () => ({ ok: false, error: "生成失败（重试 2 次）: 越权" }),
    } as unknown as AppFactory);
    const id = q2.submit(spec);
    await wait(50);
    expect(q2.get(id)?.status).toBe("failed");
    expect(q2.get(id)?.error).toMatch(/越权/);
  });

  it("生成器抛错 → failed", async () => {
    const q3 = new GeneratorQueue();
    q3.init({
      generate: async () => {
        throw new Error("LLM 网络错误");
      },
    } as unknown as AppFactory);
    const id = q3.submit(spec);
    await wait(50);
    expect(q3.get(id)?.status).toBe("failed");
    expect(q3.get(id)?.error).toMatch(/网络/);
  });

  it("list 返回任务列表", () => {
    q.submit(spec);
    expect(q.list().length).toBe(1);
  });

  it("submitUpdate 入队更新任务：task.kind=update 且走 factory.update（含进度）", async () => {
    let captured: { appId: string; description: string; sessionId?: string } | undefined;
    let progressSteps: string[] = [];
    const q2 = new GeneratorQueue();
    q2.init({
      generate: async () => ({ ok: true, app: { id: "x", name: "x", version: "1.0.0", type: "app", status: "running" } }),
      update: async (appId, description, sessionId, onProgress) => {
        captured = { appId, description, sessionId };
        onProgress?.("更新", 0, 30, "读取现有应用结构…");
        onProgress?.("更新", 5, 30, "app.js 已更新");
        return { ok: true, app: { id: appId, name: "x", version: "1.0.1", type: "app", status: "running" } };
      },
    } as unknown as AppFactory);
    const id = q2.submitUpdate("gen-1", "加暂停按钮", "sess-1");
    expect(id).toMatch(/^genjob-/);
    const job = q2.get(id)!;
    expect(job.task).toMatchObject({ kind: "update", appId: "gen-1", description: "加暂停按钮", sessionId: "sess-1" });
    await wait(50);
    expect(q2.get(id)?.status).toBe("done");
    expect(captured).toMatchObject({ appId: "gen-1", description: "加暂停按钮", sessionId: "sess-1" });
    expect(q2.get(id)?.result?.app?.version).toBe("1.0.1");
  });

  it("submitUpdate 更新失败 → failed + error", async () => {
    const q3 = new GeneratorQueue();
    q3.init({
      update: async () => ({ ok: false, error: "未检测到文件变更（模型未写入文件）" }),
    } as unknown as AppFactory);
    const id = q3.submitUpdate("gen-2", "换个主题色");
    await wait(50);
    expect(q3.get(id)?.status).toBe("failed");
    expect(q3.get(id)?.error).toMatch(/未检测到文件变更/);
  });
});
