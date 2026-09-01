/**
 * 语音识别服务（Sprint 43）— 非流式离线 ASR（sherpa-onnx paraformer-zh）
 * 同构 tts-provider：AsrProvider 接口 + 就绪解析 + 懒加载单例缓存
 * 决策（spike 实测）：非流式（按住说话→录完识别）——本环境流式路径原生崩溃，非流式逐字精准；
 * 输入须 16kHz 单声道 PCM（Web 端降采样；1.10.46 无 LinearResampler，非 16k 明确报错）
 */

import sherpa from "sherpa-onnx-node";
import { isModelReady, modelDir } from "./model-manager.js";

export interface AsrResult {
  text: string;
}

export interface AsrProvider {
  readonly engine: string;
  transcribe(samples: Float32Array, sampleRate: number): Promise<AsrResult>;
}

const TARGET_SAMPLE_RATE = 16000;

type SherpaRecognizer = InstanceType<typeof sherpa.OfflineRecognizer>;

/** sherpa paraformer-zh（懒加载：首次 transcribe 才加载 232MB 模型，进程内缓存复用） */
export class SherpaAsrProvider implements AsrProvider {
  readonly engine = "sherpa-paraformer-zh";
  private recognizer: SherpaRecognizer | null = null;

  constructor(private dataDir: string) {}

  private ensureRecognizer(): SherpaRecognizer {
    if (this.recognizer) return this.recognizer;
    const dir = modelDir(this.dataDir, "asr");
    this.recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: TARGET_SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        paraformer: { model: `${dir}/model.onnx` },
        tokens: `${dir}/tokens.txt`,
        numThreads: 2,
        provider: "cpu",
        debug: 0,
      },
      decodingMethod: "greedy_search",
    });
    return this.recognizer;
  }

  async transcribe(samples: Float32Array, sampleRate: number): Promise<AsrResult> {
    if (sampleRate !== TARGET_SAMPLE_RATE) {
      throw new Error(`仅支持 ${TARGET_SAMPLE_RATE}Hz 音频（收到 ${sampleRate}Hz），Web 端请降采样后上传`);
    }
    if (samples.length === 0) return { text: "" };
    const r = this.ensureRecognizer();
    const stream = r.createStream();
    stream.acceptWaveform({ samples, sampleRate: TARGET_SAMPLE_RATE });
    r.decode(stream);
    const result = r.getResult(stream);
    return { text: result.text };
  }
}

/** 按模型就绪解析 ASR provider；未就绪返回 null（detail 指引下载/放置） */
export function resolveAsrProvider(dataDir: string): AsrProvider | null {
  if (!isModelReady(dataDir, "asr")) return null;
  return new SherpaAsrProvider(dataDir);
}

/** 进程内单例缓存（仅缓存非空实例：模型就绪后才缓存，避免"未就绪→下载→仍不可用"的陈旧 null；
 *  未就绪时每次重新探测（纯 stat 检查，廉价），下载成功后自动生效） */
let cached: { dataDir: string; provider: AsrProvider } | null = null;

export function getAsrProvider(dataDir: string): AsrProvider | null {
  if (cached && cached.dataDir === dataDir) return cached.provider;
  const provider = resolveAsrProvider(dataDir);
  cached = provider ? { dataDir, provider } : null;
  return provider;
}
