/**
 * edge-tts 客户端（Sprint 36）— 直连微软在线 TTS 接口（WebSocket + SSML）
 * 依赖 ws 包（npm 包 edge-tts 的 main 指向 TS 源码无法被 Node ESM 直接加载，故本地实现等价协议）。
 * 注意：第三方微软接口在特定网络/地区可能 403（当前环境已验证）；调用方需处理降级。
 */

import WebSocket from "ws";
import { randomUUID } from "node:crypto";

const BASE = "speech.platform.bing.com/consumer/speech/synthesize/readaloud";
const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WS_URL = `wss://${BASE}/edge/v1?TrustedClientToken=${TOKEN}`;

export interface EdgeTtsOptions {
  voice?: string;
  rate?: string;
  volume?: string;
  pitch?: string;
}

function uuid(): string {
  return randomUUID().replaceAll("-", "");
}

function buildSynthesisMessage(text: string, opts: EdgeTtsOptions): string {
  const voice = opts.voice ?? "zh-CN-XiaoxiaoNeural";
  const rate = opts.rate ?? "+0%";
  const volume = opts.volume ?? "+0%";
  const pitch = opts.pitch ?? "+0Hz";
  const requestId = uuid();
  const ts = new Date().toISOString();
  const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>${escapeXml(text)}</prosody></voice></speak>`;
  return [
    `X-RequestId: ${requestId}`,
    "Content-Type: application/ssml+xml",
    `X-Timestamp: ${ts}`,
    "Path: ssml",
    "",
    ssml,
  ].join("\r\n");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 合成整段 MP3 音频（连接建立 → speech.config → ssml → 收帧 → turn.end） */
export function edgeTtsSynthesize(text: string, opts: EdgeTtsOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}&ConnectionId=${uuid()}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      },
    });
    const frames: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new Error("edge-tts 合成超时（网络或接口不可用）"));
    }, 20000);

    ws.on("open", () => {
      // speech.config
      ws.send(
        [
          "X-RequestId: " + uuid(),
          "Content-Type: application/json; charset=utf-8",
          "Path: speech.config",
          "",
          JSON.stringify({
            context: {
              synthesis: {
                audio: { metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "true" }, outputFormat: "audio-24khz-48kbitrate-mono-mp3" },
              },
            },
          }),
        ].join("\r\n"),
      );
      ws.send(buildSynthesisMessage(text, opts));
    });

    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        const data = raw.toString("utf8");
        if (data.includes("turn.end")) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          ws.close();
          resolve(Buffer.concat(frames));
        }
        return;
      }
      // MP3 帧（跳过 2 字节头 + Path 字段）
      const pathEnd = raw.indexOf(0x0a);
      if (pathEnd > 0) frames.push(raw.subarray(pathEnd + 2));
    });

    ws.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });

    ws.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(frames.length > 0 ? "edge-tts 连接提前关闭（音频不完整）" : "edge-tts 连接关闭（接口可能拒绝访问）"));
    });
  });
}
