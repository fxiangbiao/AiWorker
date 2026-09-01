/**
 * media-server（Sprint 36）— WS 音频通道（/api/v1/audio）
 * 请求/响应式（非全局总线）：客户端发 {type:"tts", reqId, text, voice?, rate?}，
 * 服务端流式回 {type:"tts:frame", reqId, audio:<base64>} → {type:"tts:end", reqId}（或 tts:error）。
 * Web 主战场语音输出用浏览器 speechSynthesis（零依赖），本通道服务后端/未来非浏览器客户端。
 */

import { WebSocketServer, type WebSocket } from "ws";
import { resolveTtsProvider, type TtsProvider, type TtsRequest } from "./tts-provider.js";

interface TtsWs extends WebSocket {
  alive?: boolean;
}

/** 设备状态探测（Sprint 42 A2）：最近一次创建的音频通道实例（只读） */
let audioWsStatus: { active: boolean; path: string; clients: () => number } | null = null;

export function getAudioWsStatus(): { active: boolean; path?: string; clients?: number } | null {
  if (!audioWsStatus) return null;
  return { active: audioWsStatus.active, path: audioWsStatus.path, clients: audioWsStatus.clients() };
}

/** 创建 /api/v1/audio WS 服务（noServer 模式；由 server 集成 upgrade 路由；provider 可注入便于测试） */
export function createAudioWs(dataDir: string, provider?: TtsProvider): { wss: WebSocketServer; path: string } {
  const wss = new WebSocketServer({ noServer: true });
  const path = "/api/v1/audio";
  const ttsProvider = provider ?? resolveTtsProvider(dataDir);
  audioWsStatus = { active: true, path, clients: () => wss.clients.size };

  wss.on("connection", (raw) => {
    const ws = raw as TtsWs;
    ws.alive = true;
    ws.on("pong", () => {
      ws.alive = true;
    });

    ws.on("message", (data) => {
      let req: { type?: string; reqId?: string; text?: string; voice?: string; rate?: string };
      try {
        req = JSON.parse(data.toString()) as typeof req;
      } catch {
        send(ws, { type: "error", message: "无效请求（JSON 解析失败）" });
        return;
      }
      if (req.type !== "tts") return;
      const reqId = typeof req.reqId === "string" ? req.reqId : `r${Date.now()}`;
      if (!req.text || typeof req.text !== "string" || !req.text.trim()) {
        send(ws, { type: "tts:error", reqId, message: "text 不能为空" });
        return;
      }
      void synthesizeAndStream(ws, reqId, { text: req.text, voice: req.voice, rate: req.rate }, ttsProvider);
    });

    ws.on("close", () => {});
    ws.on("error", () => {});
  });

  // 心跳清理死连接（与全局总线一致）
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const c = client as TtsWs;
      if (c.alive === false) {
        c.terminate();
        continue;
      }
      c.alive = false;
      c.ping();
    }
  }, 30000);
  wss.on("close", () => clearInterval(heartbeat));

  return { wss, path };
}

async function synthesizeAndStream(ws: TtsWs, reqId: string, req: TtsRequest, provider: TtsProvider): Promise<void> {
  try {
    if (provider.stream) {
      for await (const frame of provider.stream(req)) {
        if (ws.readyState !== ws.OPEN) return;
        send(ws, { type: "tts:frame", reqId, audio: frame.toString("base64") });
      }
    } else {
      const audio = await provider.synthesize(req);
      if (ws.readyState !== ws.OPEN) return;
      send(ws, { type: "tts:frame", reqId, audio: audio.toString("base64") });
    }
    if (ws.readyState === ws.OPEN) send(ws, { type: "tts:end", reqId });
  } catch (err) {
    if (ws.readyState === ws.OPEN) {
      send(ws, { type: "tts:error", reqId, message: (err as Error).message });
    }
  }
}

function send(ws: TtsWs, data: object): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
}
