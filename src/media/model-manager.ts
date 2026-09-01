/**
 * 语音模型管理（Sprint 43）— 就绪探测 + hf-mirror 下载
 * 模型仓库固定版本（hf-mirror 镜像源，实测可达；huggingface.co 直连超时）
 * 注意：vits-zh-ll 的 dict/user.dict.utf8 在仓库中为 0 字节（minSize=0，仅存在性校验）
 */

import { existsSync, mkdirSync, statSync, createWriteStream, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type ModelKind = "asr" | "tts";

export interface ModelFileSpec {
  remote: string;
  local: string;
  /** 展示用体积（KB） */
  sizeKb: number;
  /** 就绪/跳过判定最小字节数（0 = 仅存在性校验） */
  minSize: number;
}

const DICT: ModelFileSpec[] = [
  { remote: "dict/hmm_model.utf8", local: "dict/hmm_model.utf8", sizeKb: 508, minSize: 1 },
  { remote: "dict/idf.utf8", local: "dict/idf.utf8", sizeKb: 5858, minSize: 1 },
  { remote: "dict/jieba.dict.utf8", local: "dict/jieba.dict.utf8", sizeKb: 4952, minSize: 1 },
  { remote: "dict/stop_words.utf8", local: "dict/stop_words.utf8", sizeKb: 9, minSize: 1 },
  { remote: "dict/user.dict.utf8", local: "dict/user.dict.utf8", sizeKb: 0, minSize: 0 },
  { remote: "dict/pos_dict/char_state_tab.utf8", local: "dict/pos_dict/char_state_tab.utf8", sizeKb: 320, minSize: 1 },
  { remote: "dict/pos_dict/prob_emit.utf8", local: "dict/pos_dict/prob_emit.utf8", sizeKb: 1648, minSize: 1 },
  { remote: "dict/pos_dict/prob_start.utf8", local: "dict/pos_dict/prob_start.utf8", sizeKb: 4, minSize: 1 },
  { remote: "dict/pos_dict/prob_trans.utf8", local: "dict/pos_dict/prob_trans.utf8", sizeKb: 121, minSize: 1 },
];

const MODEL_MANIFESTS: Record<ModelKind, { label: string; repo: string; files: ModelFileSpec[] }> = {
  asr: {
    label: "离线语音识别（paraformer-zh int8）",
    repo: "csukuangfj/sherpa-onnx-paraformer-zh-2023-09-14",
    files: [
      { remote: "model.int8.onnx", local: "model.onnx", sizeKb: 237667, minSize: 1 },
      { remote: "tokens.txt", local: "tokens.txt", sizeKb: 1, minSize: 1 },
      { remote: "am.mvn", local: "am.mvn", sizeKb: 11, minSize: 1 },
    ],
  },
  tts: {
    label: "离线语音合成（vits-zh-ll）",
    repo: "csukuangfj/sherpa-onnx-vits-zh-ll",
    files: [
      { remote: "model.onnx", local: "model.onnx", sizeKb: 118263, minSize: 1 },
      { remote: "tokens.txt", local: "tokens.txt", sizeKb: 1, minSize: 1 },
      { remote: "lexicon.txt", local: "lexicon.txt", sizeKb: 368, minSize: 1 },
      { remote: "date.fst", local: "date.fst", sizeKb: 58, minSize: 1 },
      { remote: "phone.fst", local: "phone.fst", sizeKb: 87, minSize: 1 },
      { remote: "number.fst", local: "number.fst", sizeKb: 63, minSize: 1 },
      { remote: "new_heteronym.fst", local: "new_heteronym.fst", sizeKb: 22, minSize: 1 },
      ...DICT,
    ],
  },
};

export function modelManifest(kind: ModelKind): { label: string; repo: string; files: ModelFileSpec[]; totalKb: number } {
  const m = MODEL_MANIFESTS[kind];
  return { label: m.label, repo: m.repo, files: m.files, totalKb: m.files.reduce((s, f) => s + f.sizeKb, 0) };
}

export function modelsDir(dataDir: string): string {
  return resolve(dataDir, "media", "models");
}

export function modelDir(dataDir: string, kind: ModelKind): string {
  return resolve(modelsDir(dataDir), kind);
}

function fileReady(dir: string, f: ModelFileSpec): boolean {
  try {
    return existsSync(resolve(dir, f.local)) && statSync(resolve(dir, f.local)).size >= f.minSize;
  } catch {
    return false;
  }
}

export function isModelReady(dataDir: string, kind: ModelKind): boolean {
  return MODEL_MANIFESTS[kind].files.every((f) => fileReady(modelDir(dataDir, kind), f));
}

/** 就绪详情（缺失文件清单；供设备 Tab / CLI 展示） */
export function modelReadyInfo(dataDir: string, kind: ModelKind): { ready: boolean; missing: string[] } {
  const dir = modelDir(dataDir, kind);
  const missing = MODEL_MANIFESTS[kind].files.filter((f) => !fileReady(dir, f)).map((f) => f.local);
  return { ready: missing.length === 0, missing };
}

const MIRROR = "https://hf-mirror.com";

export interface DownloadProgress {
  file: string;
  phase: "start" | "done";
  received: number;
  total: number;
}

/** 下载进行中标记（防并发双写同一文件；单 kind 同时只允许一个下载任务） */
let inFlight: ModelKind | null = null;

/** 从 hf-mirror 下载模型（幂等：已就绪文件跳过；失败清理半成品并返回可读错误） */
export async function downloadModel(
  dataDir: string,
  kind: ModelKind,
  onProgress?: (p: DownloadProgress) => void,
): Promise<{ ok: boolean; downloaded: string[]; skipped: string[]; error?: string }> {
  if (inFlight) {
    return { ok: false, downloaded: [], skipped: [], error: "已有下载任务进行中，请稍候" };
  }
  inFlight = kind;
  const manifest = MODEL_MANIFESTS[kind];
  const dir = modelDir(dataDir, kind);
  mkdirSync(dir, { recursive: true });
  const downloaded: string[] = [];
  const skipped: string[] = [];
  try {
    for (const f of manifest.files) {
      const dest = resolve(dir, f.local);
      try {
        if (fileReady(dir, f)) {
          skipped.push(f.local);
          continue;
        }
        const url = `${MIRROR}/${manifest.repo}/resolve/main/${f.remote}`;
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok || !res.body) {
          return { ok: false, downloaded, skipped, error: `${f.local} 下载失败（HTTP ${res.status}）` };
        }
        const total = Number(res.headers.get("content-length") ?? 0);
        onProgress?.({ file: f.local, phase: "start", received: 0, total });
        mkdirSync(resolve(dir, dirname(f.local)), { recursive: true });
        await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(dest));
        downloaded.push(f.local);
        onProgress?.({ file: f.local, phase: "done", received: total, total });
      } catch (err) {
        // 失败清理半成品：残留文件会通过 size>0 的就绪判定 → 未来下载跳过 → 模型损坏
        try {
          rmSync(dest, { force: true });
        } catch {
          /* 清理失败不影响错误返回 */
        }
        return { ok: false, downloaded, skipped, error: `${f.local}: ${(err as Error).message}` };
      }
    }
    return { ok: true, downloaded, skipped };
  } finally {
    inFlight = null;
  }
}
