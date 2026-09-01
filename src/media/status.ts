/**
 * 设备状态汇总（Sprint 42 A2；Sprint 43 真实化 asr/tts 就绪）— 只读探测，不启动不修改
 * 三通道：ASR（sherpa paraformer-zh 离线，模型就绪即启用）、TTS（sherpa vits 就绪优先 / edge-tts 在线）、媒体服务器（WS 音频通道）
 * 模型能力：当前模型是否支持视觉（多模态）
 */

import { getAudioWsStatus } from "./media-server.js";
import { resolveTtsProvider } from "./tts-provider.js";
import { getAsrProvider } from "./asr.js";
import { isModelReady, modelReadyInfo } from "./model-manager.js";
import type { ModelRouter } from "../core/model-router.js";

export interface DeviceStatus {
  asr: { enabled: boolean; engine: string; detail: string };
  tts: { engine: string; localModelReady: boolean; detail: string };
  mediaServer: { active: boolean; path?: string; clients?: number };
  model: { current: string; vision: boolean; detail: string };
}

export function getDeviceStatus(dataDir: string, modelRouter?: ModelRouter): DeviceStatus {
  const asrInfo = modelReadyInfo(dataDir, "asr");
  const ttsInfo = modelReadyInfo(dataDir, "tts");
  const ws = getAudioWsStatus();
  const vision = modelRouter?.supportsVision?.() === true;
  return {
    asr: {
      enabled: getAsrProvider(dataDir) !== null,
      engine: "sherpa-paraformer-zh",
      detail: asrInfo.ready
        ? "paraformer-zh 离线就绪（按住说话→识别）"
        : `未就绪（缺: ${asrInfo.missing.join(", ") || "未下载"}）— 设置→设备→一键下载`,
    },
    tts: {
      engine: resolveTtsProvider(dataDir).engine,
      localModelReady: isModelReady(dataDir, "tts"),
      detail: ttsInfo.ready
        ? "sherpa vits-zh-ll 离线就绪"
        : `edge-tts 在线降级（本地模型缺: ${ttsInfo.missing.join(", ") || "未下载"}）`,
    },
    mediaServer: { active: ws?.active ?? false, path: ws?.path, clients: ws?.clients ?? 0 },
    model: {
      current: modelRouter?.getDisplayModel?.() ?? "",
      vision,
      detail: vision ? "当前模型支持图片输入（多模态）" : "当前模型不支持视觉（图片提问需 vision:true 的模型）",
    },
  };
}
