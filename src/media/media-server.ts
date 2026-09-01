/**
 * media-server（Sprint 36）— WS 音频通道（/api/v1/audio）
 * 请求/响应式（非全局总线）：客户端发 {type:"tts", reqId, text, voice?, rate?}，
 * 服务端流式回 {type:"tts:frame", reqId, audio:<base64>} → {type:"tts:end", reqId}（或 tts:error）。
 * Web 主战场语音输出用浏览器 speechSynthesis（零依赖），本通道服务后端/未来非浏览器客户端。
 */

import { WebSocketServer, type WebSocket } from "ws";
import { resolveTtsProvider, type TtsProvider, type TtsRequest } from "./tts-provider.js";
import type { AsrProvider } from "./asr.js";

interface TtsWs extends WebSocket {
  alive?: boolean;
}

/** 设备状态探测（Sprint 42 A2）：最近一次创建的音频通道实例（只读） */
let audioWsStatus: { active: boolean; path: string; clients: () => number } | null = null;

export function getAudioWsStatus(): { active: boolean; path?: string; clients?: number } | null {
  if (!audioWsStatus) return null;
  return { active: audioWsStatus.active, path: audioWsStatus.path, clients: audioWsStatus.clients() };
}

/** 创建 /api/v1/audio WS 服务（noServer 模式；由 server 集成 upgrade 路由；provider 可注入便于测试）
 * Sprint 43：新增 ASR 上行（asrProvider 未注入或无模型时明确报错） */
export function createAudioWs(
  dataDir: string,
  provider?: TtsProvider,
  asrProvider?: AsrProvider | null,
): { wss: WebSocketServer; path: string } {
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
      let req: { type?: string; reqId?: string; text?: string; voice?: string; rate?: string; audio?: string; sampleRate?: number };
      try {
        req = JSON.parse(data.toString()) as typeof req;
      } catch {
        send(ws, { type: "error", message: "无效请求（JSON 解析失败）" });
        return;
      }
      if (req.type === "asr") {
        void handleAsr(ws, req, asrProvider);
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

/** base64（16k 单声道 16-bit PCM，小端）→ Float32Array [-1,1] */
function base64ToFloat32(audioB64: string): { samples: Float32Array; sampleRate: number } | null {
  try {
    const buf = Buffer.from(audioB64, "base64");
    if (buf.length === 0 || buf.length % 2 !== 0) return null;
    const pcm = new Int16Array(buf.length / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(i * 2);
    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i]! / 32768;
    return { samples, sampleRate: 16000 };
  } catch {
    return null;
  }
}

/** ASR 上行：base64 PCM → 非流式识别 → asr:result / asr:error（一次性整段，按住说话 ≤60s） */
async function handleAsr(
  ws: TtsWs,
  req: { reqId?: string; audio?: string; sampleRate?: number },
  asrProvider?: AsrProvider | null,
): Promise<void> {
  const reqId = typeof req.reqId === "string" ? req.reqId : `r${Date.now()}`;
  const fail = (message: string) => {
    if (ws.readyState === ws.OPEN) send(ws, { type: "asr:error", reqId, message });
  };
  if (!asrProvider) {
    fail("语音识别模型未安装（设置→设备→一键下载，或 /media download asr）");
    return;
  }
  if (typeof req.audio !== "string" || !req.audio) {
    fail("audio 不能为空（16k 单声道 16-bit PCM base64）");
    return;
  }
  if (req.sampleRate !== undefined && req.sampleRate !== 16000) {
    fail(`仅支持 16000Hz（收到 ${req.sampleRate}Hz），请降采样后上传`);
    return;
  }
  const decoded = base64ToFloat32(req.audio);
  if (!decoded) {
    fail("audio 解码失败（需 16k 单声道 16-bit PCM base64）");
    return;
  }
  try {
    const result = await asrProvider.transcribe(decoded.samples, decoded.sampleRate);
    if (ws.readyState === ws.OPEN) send(ws, { type: "asr:result", reqId, text: result.text });
  } catch (err) {
    fail((err as Error).message);
  }
}

function send(ws: TtsWs, data: object): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
}
