/**
 * 设备状态汇总（Sprint 42 A2）— 只读探测，不启动不修改
 * 三通道：ASR（语音输入，Sprint 36 决策放弃 → 未启用）、TTS（edge-tts 在线 / sherpa 本地）、媒体服务器（WS 音频通道）
 * 模型能力：当前模型是否支持视觉（多模态）
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getAudioWsStatus } from "./media-server.js";
import { resolveTtsProvider } from "./tts-provider.js";
import type { ModelRouter } from "../core/model-router.js";

export interface DeviceStatus {
  asr: { enabled: boolean; detail: string };
  tts: { engine: string; localModelReady: boolean; detail: string };
  mediaServer: { active: boolean; path?: string; clients?: number };
  model: { current: string; vision: boolean; detail: string };
}

export function getDeviceStatus(dataDir: string, modelRouter?: ModelRouter): DeviceStatus {
  const ttsProvider = resolveTtsProvider(dataDir);
  const sherpaReady = existsSync(resolve(dataDir, "media", "models", "tts"));
  const ws = getAudioWsStatus();
  const vision = modelRouter?.supportsVision?.() === true;
  return {
    asr: { enabled: false, detail: "语音输入未启用（网络受限，Sprint 36 决策；保留图片多模态）" },
    tts: {
      engine: ttsProvider.engine,
      localModelReady: sherpaReady,
      detail:
        ttsProvider.engine === "sherpa"
          ? "sherpa-onnx 本地模型就绪（离线 TTS）"
          : "edge-tts 在线合成（无 key；特定网络/地区可能 403）",
    },
    mediaServer: { active: ws?.active ?? false, path: ws?.path, clients: ws?.clients ?? 0 },
    model: {
      current: modelRouter?.getDisplayModel?.() ?? "",
      vision,
      detail: vision ? "当前模型支持图片输入（多模态）" : "当前模型不支持视觉（图片提问需 vision:true 的模型）",
    },
  };
}
