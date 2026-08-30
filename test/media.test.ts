/**
 * Sprint 36 媒体测试 — TTS provider 降级 / media-server WS 音频通道 / 多模态组装
 */

import { describe, it, expect } from "vitest";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Server } from "node:http";
import { createAudioWs } from "../src/media/media-server.js";
import { resolveTtsProvider, EdgeTtsProvider } from "../src/media/tts-provider.js";
import type { TtsProvider, TtsRequest } from "../src/media/tts-provider.js";
import { SessionStore } from "../src/memory/session-store.js";
import { ContextManager } from "../src/core/context-manager.js";
import { makeTestDir } from "./helpers.js";

const testDir = makeTestDir("media");

describe("TTS provider 解析与降级", () => {
  it("无本地 sherpa 模型 → 解析为 edge-tts 在线 provider", () => {
    const p = resolveTtsProvider(testDir);
    expect(p).toBeInstanceOf(EdgeTtsProvider);
    expect(p.engine).toBe("edge-tts");
  });

  it("sherpa 模型目录存在 → 解析为 sherpa provider（本地优先，离线可用）", () => {
    mkdirSync(resolve(testDir, "media", "models", "tts"), { recursive: true });
    const p = resolveTtsProvider(testDir);
    expect(p.engine).toBe("sherpa");
  });
});

describe("media-server WS 音频通道（/api/v1/audio）", () => {
  it("TTS 请求 → 流式帧 → end（mock provider）", async () => {
    const mockProvider: TtsProvider = {
      engine: "edge-tts",
      async synthesize(req: TtsRequest) {
        return Buffer.from(`audio-${req.text.length}`, "utf-8");
      },
    };
    const audio = createAudioWs(testDir, mockProvider);
    // 独立 HTTP server 挂载 upgrade
    const http = await import("node:http");
    const server: Server = http.createServer((_req, res) => res.end());
    server.on("upgrade", (req, socket, head) => {
      if (req.url === audio.path) {
        audio.wss.handleUpgrade(req, socket, head, (ws) => audio.wss.emit("connection", ws, req));
      } else {
        socket.destroy();
      }
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    const { WebSocket: WsClient } = await import("ws");
    const ws = new WsClient(`ws://127.0.0.1:${port}${audio.path}`);
    const frames: string[] = [];
    let ended = false;
    let failed: string | null = null;
    await new Promise<void>((resolveDone) => {
      ws.on("message", (d) => {
        const msg = JSON.parse(d.toString()) as { type: string; audio?: string; message?: string };
        if (msg.type === "tts:frame") frames.push(msg.audio ?? "");
        else if (msg.type === "tts:end") {
          ended = true;
          resolveDone();
        } else if (msg.type === "tts:error") {
          failed = msg.message ?? "error";
          resolveDone();
        }
      });
      ws.on("open", () => ws.send(JSON.stringify({ type: "tts", reqId: "r1", text: "你好" })));
      ws.on("error", () => {
        failed = "ws error";
        resolveDone();
      });
    });
    ws.close();
    audio.wss.close();
    server.close();
    expect(failed).toBeNull();
    expect(frames.length).toBeGreaterThan(0);
    expect(Buffer.from(frames[0]!, "base64").toString("utf-8")).toContain("audio-");
    expect(ended).toBe(true);
  });

  it("provider 抛错 → tts:error（含 reqId）", async () => {
    const badProvider: TtsProvider = {
      engine: "sherpa",
      async synthesize() {
        throw new Error("本地 TTS 未安装");
      },
    };
    const audio = createAudioWs(testDir, badProvider);
    const http = await import("node:http");
    const server: Server = http.createServer((_req, res) => res.end());
    server.on("upgrade", (req, socket, head) => {
      if (req.url === audio.path) {
        audio.wss.handleUpgrade(req, socket, head, (ws) => audio.wss.emit("connection", ws, req));
      } else {
        socket.destroy();
      }
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    const { WebSocket: WsClient } = await import("ws");
    const ws = new WsClient(`ws://127.0.0.1:${port}${audio.path}`);
    const errs: string[] = [];
    await new Promise<void>((resolveDone) => {
      ws.on("message", (d) => {
        const msg = JSON.parse(d.toString()) as { type: string; reqId?: string; message?: string };
        if (msg.type === "tts:error") {
          errs.push(msg.message ?? "");
          resolveDone();
        }
      });
      ws.on("open", () => ws.send(JSON.stringify({ type: "tts", reqId: "r9", text: "x" })));
    });
    ws.close();
    audio.wss.close();
    server.close();
    expect(errs).toContain("本地 TTS 未安装");
  });
});

describe("多模态消息组装（assembleContext 带 images）", () => {
  it("带图片 → 用户消息 content 为数组（text + image_url）；无图片 → 纯字符串", async () => {
    const store = new SessionStore(resolve(testDir, "mm.db"));
    const ctxMgr = new ContextManager(store, resolve(testDir, "mm"));
    const sid = store.createSession("test").id;
    try {
      const msgs = await ctxMgr.assembleContext("sys", sid, "这是什么", "test", ["data:image/png;base64,AAA"]);
      const user = msgs[msgs.length - 1]!;
      expect(Array.isArray(user.content)).toBe(true);
      const parts = user.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
      expect(parts[0]).toMatchObject({ type: "text", text: "这是什么" });
      expect(parts[1]).toMatchObject({ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } });

      const msgs2 = await ctxMgr.assembleContext("sys", sid, "hi");
      expect(typeof msgs2[msgs2.length - 1]!.content).toBe("string");
    } finally {
      store.close();
    }
  });
});
