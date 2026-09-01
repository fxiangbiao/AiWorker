/**
 * TTS provider（Sprint 36；Sprint 43 补齐 sherpa 离线实现）— adapter 化文字转语音
 * 优先级：sherpa-onnx 本地（模型就绪时启用，离线）→ edge-tts 在线（微软接口，无 key）
 * 注意：edge-tts 走第三方微软在线接口，特定网络/地区可能 403；Web 主战场语音输出
 * 优先用浏览器内置 speechSynthesis（零依赖、离线），本模块服务后端/未来非浏览器客户端。
 */

import { edgeTtsSynthesize, type EdgeTtsOptions } from "./edge-tts.js";
import sherpa from "sherpa-onnx-node";
import { isModelReady, modelDir } from "./model-manager.js";

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

// ── sherpa-onnx 本地实现（Sprint 43：vits-zh-ll 真实现；模型未就绪时由 resolve 降级 edge-tts） ──

type SherpaTts = InstanceType<typeof sherpa.OfflineTts>;

function pcm16FromF32(samples: Float32Array): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return buf;
}

/** 16k 单声道 16-bit PCM → WAV（自描述格式；与 edge-tts 的 mp3 输出格式不同，消费端按 engine 区分） */
function wavFromPcm16(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

class SherpaTtsProvider implements TtsProvider {
  readonly engine: TtsEngine = "sherpa";
  private tts: SherpaTts | null = null;

  constructor(private dataDir: string) {}

  private ensure(): SherpaTts {
    if (this.tts) return this.tts;
    const dir = modelDir(this.dataDir, "tts");
    this.tts = new sherpa.OfflineTts({
      model: {
        vits: {
          model: `${dir}/model.onnx`,
          tokens: `${dir}/tokens.txt`,
          lexicon: `${dir}/lexicon.txt`,
          dictDir: `${dir}/dict`,
        },
        numThreads: 2,
        debug: 0,
      },
      ruleFsts: `${dir}/phone.fst,${dir}/date.fst,${dir}/number.fst,${dir}/new_heteronym.fst`,
      maxNumSentences: 1,
    });
    return this.tts;
  }

  async synthesize(req: TtsRequest): Promise<Buffer> {
    const tts = this.ensure();
    const speed = parseFloat(req.rate ?? "1.0") || 1.0;
    const audio = tts.generate({ text: req.text, sid: 0, speed });
    if (!audio.samples || audio.samples.length === 0) throw new Error("sherpa TTS 合成失败（空音频）");
    return wavFromPcm16(pcm16FromF32(audio.samples), audio.sampleRate);
  }
}

/** 按模型就绪解析 TTS provider：sherpa 模型就绪优先，否则 edge-tts，最后抛错 */
export function resolveTtsProvider(dataDir: string): TtsProvider {
  return isModelReady(dataDir, "tts") ? new SherpaTtsProvider(dataDir) : new EdgeTtsProvider();
}

export { EdgeTtsProvider, SherpaTtsProvider };
