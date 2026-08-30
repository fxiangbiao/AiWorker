/**
 * TTS provider（Sprint 36）— adapter 化文字转语音
 * 优先级：edge-tts 在线（默认，微软接口，无 key）→ sherpa-onnx 本地（P1，模型就绪时自动启用）
 * 注意：edge-tts 走第三方微软在线接口，特定网络/地区可能 403；Web 主战场语音输出
 * 优先用浏览器内置 speechSynthesis（零依赖、离线），本模块服务后端/未来非浏览器客户端。
 */

import { edgeTtsSynthesize, type EdgeTtsOptions } from "./edge-tts.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type TtsEngine = "edge-tts" | "sherpa";

export interface TtsRequest {
  text: string;
  voice?: string;
  /** 语速（edge-tts: "+0%"，sherpa: 倍率 1.0） */
  rate?: string;
}

export interface TtsProvider {
  readonly engine: TtsEngine;
  /** 合成整段音频（返回音频 Buffer；失败抛错） */
  synthesize(req: TtsRequest): Promise<Buffer>;
  /** 流式合成（音频帧） */
  stream?(req: TtsRequest): AsyncGenerator<Buffer>;
}

// ── edge-tts 在线实现 ──

class EdgeTtsProvider implements TtsProvider {
  readonly engine: TtsEngine = "edge-tts";

  async synthesize(req: TtsRequest): Promise<Buffer> {
    const opts: EdgeTtsOptions = { voice: req.voice ?? "zh-CN-XiaoxiaoNeural", rate: req.rate ?? "+0%" };
    return edgeTtsSynthesize(req.text, opts);
  }
}

// ── sherpa-onnx 本地实现（P1：模型就绪时启用；未实现时 synthesize 抛错触发降级） ──

class SherpaTtsProvider implements TtsProvider {
  readonly engine: TtsEngine = "sherpa";
  async synthesize(_req: TtsRequest): Promise<Buffer> {
    throw new Error("sherpa-onnx 本地 TTS 未安装（P1）；请在 data/media/models/ 放置模型并确认原生绑定可用");
  }
}

/** 数据目录下的模型目录（sherpa 模型就绪探测） */
const modelDir = (dataDir: string) => resolve(dataDir, "media", "models");

/** 按可用性解析 TTS provider：sherpa 模型就绪优先，否则 edge-tts，最后抛错 */
export function resolveTtsProvider(dataDir: string): TtsProvider {
  const sherpaReady = existsSync(resolve(modelDir(dataDir), "tts"));
  return sherpaReady ? new SherpaTtsProvider() : new EdgeTtsProvider();
}

export { EdgeTtsProvider, SherpaTtsProvider };
