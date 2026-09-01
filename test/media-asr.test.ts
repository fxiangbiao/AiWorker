/**
 * 语音识别单测（Sprint 43）— ASR provider 解析/守卫 + WS asr 协议（mock provider）
 * 真实识别冒烟：RUN_MEDIA_SMOKE=1 且模型就绪时本地跑（不进 CI）
 */

import { describe, it, expect, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Server } from "node:http";
import { createAudioWs } from "../src/media/media-server.js";
import { resolveAsrProvider, SherpaAsrProvider, getAsrProvider, type AsrProvider } from "../src/media/asr.js";
import { modelDir, modelManifest } from "../src/media/model-manager.js";
import { makeTestDir } from "./helpers.js";

const dir = makeTestDir("media-asr");

function seedAsrModel(): void {
  seedAsrModelIn(dir);
}

function seedAsrModelIn(baseDir: string): void {
  const base = modelDir(baseDir, "asr");
  for (const f of modelManifest("asr").files) {
    const p = resolve(base, f.local);
    mkdirSync(resolve(p, ".."), { recursive: true });
    writeFileSync(p, f.minSize > 0 ? "x".repeat(4) : "", "utf-8");
  }
}

/** Float32 → 16k 16-bit PCM base64（与 Web 端协议一致） */
function pcmB64(values: number[]): string {
  const f32 = new Float32Array(values);
  const buf = new ArrayBuffer(f32.length * 2);
  const v = new DataView(buf);
  for (let i = 0; i < f32.length; i++) v.setInt16(i * 2, f32[i]! * 32767, true);
  return Buffer.from(buf).toString("base64");
}

describe("ASR provider（Sprint 43）", () => {
  it("模型未就绪 → resolveAsrProvider null", () => {
    expect(resolveAsrProvider(dir)).toBeNull();
  });

  it("模型就绪 → resolve 返回 sherpa provider（engine 标注）", () => {
    seedAsrModel();
    const p = resolveAsrProvider(dir);
    expect(p).not.toBeNull();
    expect(p!.engine).toBe("sherpa-paraformer-zh");
  });

  it("getAsrProvider 按 dataDir 缓存复用实例", () => {
    const fresh = makeTestDir("media-asr-cache");
    const a = getAsrProvider(fresh);
    const b = getAsrProvider(fresh);
    expect(a).toBeNull();
    expect(a).toBe(b);
  });

  it("getAsrProvider 不缓存 null：未就绪→下载/放置模型后自动生效（无需重启）", () => {
    const fresh = makeTestDir("media-asr-cache2");
    expect(getAsrProvider(fresh)).toBeNull(); // 未就绪：不缓存 null
    seedAsrModelIn(fresh);
    const p = getAsrProvider(fresh); // 重新探测 → 就绪
    expect(p).not.toBeNull();
    expect(p!.engine).toBe("sherpa-paraformer-zh");
  });

  it("非 16k 输入明确报错（不加载模型）", async () => {
    const p = new SherpaAsrProvider(dir);
    await expect(p.transcribe(new Float32Array(10), 48000)).rejects.toThrow("16000");
  });

  it("空音频直接返回空文本（不加载模型）", async () => {
    const p = new SherpaAsrProvider(dir);
    const r = await p.transcribe(new Float32Array(0), 16000);
    expect(r.text).toBe("");
  });

  it("真实识别冒烟（RUN_MEDIA_SMOKE=1 且模型就绪时本地验证）", async () => {
    const run = process.env.RUN_MEDIA_SMOKE === "1";
    const ready = modelManifest("asr").files.every((f) => {
      try {
        const p = resolve(modelDir(dir, "asr"), f.local);
        const { existsSync, statSync } = require("node:fs") as typeof import("node:fs");
        return existsSync(p) && statSync(p).size >= f.minSize;
      } catch {
        return false;
      }
    });
    if (!run || !ready) return; // 跳过（CI 不跑）
    // 需要真实模型文件时，用模型自带 wav（此处由外部准备）
    const sherpa = (await import("sherpa-onnx-node")).default;
    const wav = sherpa.readWave(resolve(modelDir(dir, "asr"), "..", "smoke.wav"));
    const p = new SherpaAsrProvider(dir);
    const r = await p.transcribe(wav.samples, wav.sampleRate);
    expect(r.text.length).toBeGreaterThan(0);
  });
});

describe("media-server WS asr 协议（Sprint 43）", () => {
  function mountWs(asrProvider?: AsrProvider | null) {
    const audio = createAudioWs(dir, undefined, asrProvider);
    const server: Server = (require("node:http") as typeof import("node:http")).createServer((_req, res) => res.end());
    server.on("upgrade", (req, socket, head) => {
      if (req.url === audio.path) audio.wss.handleUpgrade(req, socket, head, (ws) => audio.wss.emit("connection", ws, req));
      else socket.destroy();
    });
    return { audio, server };
  }

  async function sendAsrMsg(server: Server, audio: { path: string }, payload: object): Promise<{ type: string; text?: string; message?: string }> {
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const { WebSocket: WsClient } = await import("ws");
    const ws = new WsClient(`ws://127.0.0.1:${port}${audio.path}`);
    const result = await new Promise<{ type: string; text?: string; message?: string }>((resolveDone) => {
      ws.on("message", (d) => {
        const msg = JSON.parse(d.toString()) as { type: string; text?: string; message?: string };
        if (msg.type === "asr:result" || msg.type === "asr:error") resolveDone(msg);
      });
      ws.on("open", () => ws.send(JSON.stringify(payload)));
      ws.on("error", () => resolveDone({ type: "asr:error", message: "ws error" }));
    });
    ws.close();
    return result;
  }

  it("ASR 请求 → asr:result（mock provider 收到 16k PCM）", async () => {
    const mockAsr: AsrProvider = {
      engine: "mock",
      async transcribe(samples, sampleRate) {
        return { text: `识别:${samples.length}@${sampleRate}` };
      },
    };
    const { audio, server } = mountWs(mockAsr);
    try {
      const r = await sendAsrMsg(server, audio, {
        type: "asr",
        reqId: "a1",
        audio: pcmB64([0.1, -0.2, 0.3, 0.5, -0.5]),
        sampleRate: 16000,
      });
      expect(r.type).toBe("asr:result");
      expect(r.text).toBe("识别:5@16000");
    } finally {
      audio.wss.close();
      server.close();
    }
  });

  it("无 asrProvider → asr:error 模型未安装", async () => {
    const { audio, server } = mountWs(undefined);
    try {
      const r = await sendAsrMsg(server, audio, { type: "asr", reqId: "a2", audio: pcmB64([0, 0]), sampleRate: 16000 });
      expect(r.type).toBe("asr:error");
      expect(r.message).toContain("未安装");
    } finally {
      audio.wss.close();
      server.close();
    }
  });

  it("非 16k sampleRate → asr:error 提示降采样", async () => {
    const mockAsr: AsrProvider = { engine: "mock", async transcribe() { return { text: "x" }; } };
    const { audio, server } = mountWs(mockAsr);
    try {
      const r = await sendAsrMsg(server, audio, { type: "asr", reqId: "a3", audio: pcmB64([0, 0]), sampleRate: 48000 });
      expect(r.type).toBe("asr:error");
      expect(r.message).toContain("16000");
    } finally {
      audio.wss.close();
      server.close();
    }
  });

  it("坏 base64 → asr:error 解码失败", async () => {
    const mockAsr: AsrProvider = { engine: "mock", async transcribe() { return { text: "x" }; } };
    const { audio, server } = mountWs(mockAsr);
    try {
      const r = await sendAsrMsg(server, audio, { type: "asr", reqId: "a4", audio: "!!!not-base64!!!", sampleRate: 16000 });
      expect(r.type).toBe("asr:error");
      expect(r.message).toContain("解码");
    } finally {
      audio.wss.close();
      server.close();
    }
  });
});
