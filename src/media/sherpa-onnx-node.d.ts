/**
 * sherpa-onnx-node 类型声明（Sprint 43）
 * 包本体为 CJS + JSDoc，无 TS 类型；仅声明本工程用到的表面
 * 注意：锁定 1.10.46（流式路径在 1.13.x 有原生崩溃；非流式 1.10.46 实测通过），无 LinearResampler
 */

declare module "sherpa-onnx-node" {
  export interface Wave {
    samples: Float32Array;
    sampleRate: number;
  }

  export interface OfflineStream {
    acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void;
  }

  export class OfflineRecognizer {
    constructor(config: Record<string, unknown>);
    createStream(): OfflineStream;
    decode(stream: OfflineStream): void;
    getResult(stream: OfflineStream): { text: string; tokens?: string[] };
  }

  export class OfflineTts {
    constructor(config: Record<string, unknown>);
    readonly sampleRate: number;
    readonly numSpeakers: number;
    generate(obj: { text: string; sid?: number; speed?: number }): Wave;
  }

  export function readWave(path: string): Wave;
  export function writeWave(path: string, wave: Wave): void;

  const sherpa: {
    OfflineRecognizer: typeof OfflineRecognizer;
    OfflineTts: typeof OfflineTts;
    readWave: typeof readWave;
    writeWave: typeof writeWave;
  };
  export default sherpa;
}
