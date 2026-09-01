/**
 * 语音模型管理单测（Sprint 43）— 就绪探测 / 幂等跳过 / 下载失败可读错误
 * 注：不真实下载（stub fetch），下载成功路径依赖网络留给冒烟/实机
 */

import { describe, it, expect, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { makeTestDir } from "./helpers.js";
import { modelDir, modelManifest, modelReadyInfo, isModelReady, downloadModel, type ModelKind } from "../src/media/model-manager.js";

const dir = makeTestDir("model-manager");

function seedFiles(kind: ModelKind): void {
  const base = modelDir(dir, kind);
  for (const f of modelManifest(kind).files) {
    const p = resolve(base, f.local);
    mkdirSync(resolve(p, ".."), { recursive: true });
    writeFileSync(p, f.minSize > 0 ? "x".repeat(4) : "", "utf-8");
  }
}

describe("语音模型管理（Sprint 43）", () => {
  it("空目录未就绪，missing 列出全部文件", () => {
    const info = modelReadyInfo(dir, "asr");
    expect(info.ready).toBe(false);
    expect(info.missing.length).toBe(modelManifest("asr").files.length);
    expect(info.missing).toContain("model.onnx");
  });

  it("全部文件就绪 → ready；user.dict 0 字节也算就绪（minSize=0）", () => {
    seedFiles("tts");
    expect(isModelReady(dir, "tts")).toBe(true);
    const info = modelReadyInfo(dir, "tts");
    expect(info.ready).toBe(true);
    expect(info.missing).toEqual([]);
  });

  it("缺一个核心文件 → 未就绪且 missing 精确", () => {
    seedFiles("asr");
    rmSync(resolve(modelDir(dir, "asr"), "model.onnx"));
    const info = modelReadyInfo(dir, "asr");
    expect(info.ready).toBe(false);
    expect(info.missing).toEqual(["model.onnx"]);
  });

  it("downloadModel 全就绪时纯跳过，不发网络请求（stub fetch 抛错）", async () => {
    seedFiles("asr");
    const stub = vi.fn(async () => {
      throw new Error("不应发起网络请求");
    });
    vi.stubGlobal("fetch", stub);
    try {
      const r = await downloadModel(dir, "asr");
      expect(r.ok).toBe(true);
      expect(r.downloaded).toEqual([]);
      expect(r.skipped.length).toBe(modelManifest("asr").files.length);
      expect(stub).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("downloadModel 下载失败返回可读错误（stub fetch 404；独立空目录避免被 seed 污染）", async () => {
    const emptyDir = makeTestDir("model-manager-empty");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, body: null, headers: new Headers() })),
    );
    try {
      const r = await downloadModel(emptyDir, "asr");
      expect(r.ok).toBe(false);
      expect(r.error).toContain("HTTP 404");
      expect(r.downloaded).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("下载中途流错误 → 失败且清理半成品文件（防残留通过 size>0 就绪判定）", async () => {
    const emptyDir = makeTestDir("model-manager-stream-err");
    const errStream = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new Error("network cut"));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "1024" }),
        body: errStream,
      })),
    );
    try {
      const r = await downloadModel(emptyDir, "asr");
      expect(r.ok).toBe(false);
      expect(r.error).toContain("network cut");
      // 半成品 model.onnx 必须被清理
      expect(existsSync(resolve(modelDir(emptyDir, "asr"), "model.onnx"))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("并发下载被 in-flight 锁拒绝（防双写同一文件）", async () => {
    const emptyDir = makeTestDir("model-manager-lock");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate; // 挂起第一个下载
        return { ok: false, status: 404, body: null, headers: new Headers() };
      }),
    );
    try {
      const first = downloadModel(emptyDir, "asr");
      // 微任务让第一个进入 in-flight
      await new Promise((r) => setTimeout(r, 10));
      const second = await downloadModel(emptyDir, "asr");
      expect(second.ok).toBe(false);
      expect(second.error).toContain("进行中");
      release();
      await first;
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
