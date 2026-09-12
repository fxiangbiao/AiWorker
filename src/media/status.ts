/**
 * 设备与能力状态（Sprint 42 A2；Sprint 49.4 改为动态探测）
 * 全部字段来自**实时探测**，不读死值：ASR/TTS 看模型文件与 provider 解析，
 * 媒体服务器看 WS 实际状态，运行时看 os/process，存储看真实 SQLite 能否建 FTS5 表，
 * 模型能力按「实测缓存（按模型失效）→ 配置声明 → 未声明」三级判定
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, freemem, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { getAudioWsStatus } from "./media-server.js";
import { resolveTtsProvider } from "./tts-provider.js";
import { getAsrProvider } from "./asr.js";
import { isModelReady, modelReadyInfo } from "./model-manager.js";
import type { ModelRouter } from "../core/model-router.js";

/** 实测结果缓存文件（写在 dataDir，git 已忽略） */
const PROBE_FILE = "device-probe.json";

export interface VisionProbeRecord {
  /** 实测时的模型名：与当前模型不一致即视为过期 */
  model: string;
  /** true=端点接受图片；false=端点明确拒绝；null=无法判定（鉴权/网络/超时） */
  supported: boolean | null;
  latencyMs: number;
  at: string;
  detail: string;
  error?: string;
}

export interface VisionCapability {
  vision: boolean;
  source: "probe" | "config" | "unknown";
  probe: VisionProbeRecord | null;
}

export interface RuntimeStatus {
  node: string;
  platform: string;
  arch: string;
  cpus: number;
  cpuModel: string;
  totalMemGB: number;
  freeMemGB: number;
  dataDir: string;
  dataDirWritable: boolean;
  pid: number;
  uptimeSec: number;
}

export interface StorageStatus {
  ok: boolean;
  sqlite: string;
  fts5: boolean;
  dbPath: string;
  dbPresent: boolean;
  dbSizeKb: number;
  error?: string;
}

export interface DeviceStatus {
  asr: { enabled: boolean; engine: string; ready: boolean; missing: string[]; detail: string };
  tts: { engine: string; localModelReady: boolean; missing: string[]; detail: string };
  mediaServer: { active: boolean; path?: string; clients?: number };
  model: {
    current: string;
    provider: string;
    baseURL: string;
    adapter?: string;
    thinking?: boolean;
    temperature?: number;
    maxTokens?: number;
    contextWindow: number;
    vision: boolean;
    visionSource: "probe" | "config" | "unknown";
    visionDeclaration?: boolean;
    visionProbe: (VisionProbeRecord & { stale?: boolean }) | null;
    detail: string;
  };
  runtime: RuntimeStatus;
  storage: StorageStatus;
}

/** 读实测缓存：文件缺失/损坏/字段非法一律按"没有实测"处理，不猜 */
export function readVisionProbe(dataDir: string): VisionProbeRecord | null {
  try {
    const raw = readFileSync(resolve(dataDir, PROBE_FILE), "utf-8");
    const parsed = JSON.parse(raw) as Partial<VisionProbeRecord>;
    if (typeof parsed.model !== "string" || parsed.model === "") return null;
    if (parsed.supported !== true && parsed.supported !== false && parsed.supported !== null) return null;
    return {
      model: parsed.model,
      supported: parsed.supported,
      latencyMs: typeof parsed.latencyMs === "number" ? parsed.latencyMs : 0,
      at: typeof parsed.at === "string" ? parsed.at : "",
      detail: typeof parsed.detail === "string" ? parsed.detail : "",
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
    };
  } catch {
    return null;
  }
}

/** 写实测缓存（失败只返回 false，不影响探测结论） */
export function writeVisionProbe(dataDir: string, record: VisionProbeRecord): boolean {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(resolve(dataDir, PROBE_FILE), `${JSON.stringify(record, null, 2)}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** 视觉能力三级判定：实测缓存（须匹配当前模型）→ 配置显式声明 → 未声明 */
export function resolveVisionCapability(dataDir: string, modelRouter?: ModelRouter): VisionCapability {
  const current = modelRouter?.getCurrentModel?.() ?? "";
  const probe = readVisionProbe(dataDir);
  if (probe && probe.supported !== null && current !== "" && probe.model === current) {
    return { vision: probe.supported, source: "probe", probe };
  }
  const declared = modelRouter?.getVisionDeclaration?.();
  if (typeof declared === "boolean") return { vision: declared, source: "config", probe };
  return { vision: false, source: "unknown", probe };
}

export function detectRuntime(dataDir: string): RuntimeStatus {
  const info = cpus();
  return {
    node: process.version,
    platform: `${platform()} ${release()}`,
    arch: arch(),
    cpus: info.length,
    cpuModel: (info[0]?.model ?? "").trim(),
    totalMemGB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    freeMemGB: Math.round((freemem() / 1024 ** 3) * 10) / 10,
    dataDir,
    dataDirWritable: isDirWritable(dataDir),
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
  };
}

/** 真实写入探测（Windows 上 accessSync 对目录不可靠） */
function isDirWritable(dir: string): boolean {
  const probe = resolve(dir, `.probe-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, "1", "utf-8");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 存储探测：真实建库 + 建 FTS5 虚表（记忆检索依赖），失败原因原样带出 */
export function detectStorage(dataDir: string): StorageStatus {
  const dbPath = resolve(dataDir, "aiworker.db");
  const base: StorageStatus = {
    ok: false,
    sqlite: "",
    fts5: false,
    dbPath,
    dbPresent: existsSync(dbPath),
    dbSizeKb: 0,
  };
  try {
    base.dbSizeKb = base.dbPresent ? Math.round(statSync(dbPath).size / 1024) : 0;
  } catch {
    /* 体积取不到不影响结论 */
  }
  try {
    const db = new Database(":memory:");
    try {
      const row = db.prepare("select sqlite_version() as v").get() as { v: string };
      base.sqlite = row.v;
      db.exec("create virtual table probe_fts using fts5(content)");
      base.fts5 = true;
      base.ok = true;
    } finally {
      db.close();
    }
  } catch (err) {
    base.error = err instanceof Error ? err.message : String(err);
  }
  return base;
}

function visionDetail(cap: VisionCapability, current: string, probe: VisionProbeRecord | null): string {
  if (cap.source === "probe" && probe) {
    return probe.supported
      ? `实测通过：端点接受图片输入（${probe.at || "刚刚"}，${probe.latencyMs}ms）`
      : `实测拒绝：端点不接受图片输入（${probe.at || "刚刚"}）${probe.error ? ` · ${probe.error}` : ""}`;
  }
  if (cap.source === "config") {
    return cap.vision ? "配置声明支持视觉（未经实测；可点【检测图片能力】复核）" : "配置显式声明不支持视觉";
  }
  const stale = probe && probe.model !== current ? `（已有实测结果属于 ${probe.model}，当前是 ${current}，已失效）` : "";
  return `未声明视觉能力且未实测：图片提问会被拒${stale}。点【检测图片能力】实测，或在 config/models.json 配置 vision:true`;
}

export function getDeviceStatus(dataDir: string, modelRouter?: ModelRouter): DeviceStatus {
  const asrInfo = modelReadyInfo(dataDir, "asr");
  const ttsInfo = modelReadyInfo(dataDir, "tts");
  const ws = getAudioWsStatus();
  const runtime = detectRuntime(dataDir);
  const storage = detectStorage(dataDir);

  const current = modelRouter?.getCurrentModel?.() ?? "";
  const profile = modelRouter?.getEffectiveProfile?.();
  const cap = resolveVisionCapability(dataDir, modelRouter);
  const cached = readVisionProbe(dataDir);
  const probe = cached ? { ...cached, ...(cached.model !== current ? { stale: true } : {}) } : null;

  return {
    asr: {
      enabled: getAsrProvider(dataDir) !== null,
      engine: "sherpa-paraformer-zh",
      ready: asrInfo.ready,
      missing: asrInfo.missing,
      detail: asrInfo.ready
        ? "paraformer-zh 离线就绪（按住说话→识别）"
        : `未就绪（缺: ${asrInfo.missing.join(", ") || "未下载"}）— 设置→设备→一键下载`,
    },
    tts: {
      engine: resolveTtsProvider(dataDir).engine,
      localModelReady: isModelReady(dataDir, "tts"),
      missing: ttsInfo.missing,
      detail: ttsInfo.ready
        ? "sherpa vits-zh-ll 离线就绪"
        : `edge-tts 在线降级（本地模型缺: ${ttsInfo.missing.join(", ") || "未下载"}）`,
    },
    mediaServer: { active: ws?.active ?? false, path: ws?.path, clients: ws?.clients ?? 0 },
    model: {
      current,
      provider: profile?.provider ?? "",
      baseURL: profile?.baseURL ?? "",
      adapter: profile?.adapter,
      thinking: profile?.thinking,
      temperature: profile?.temperature,
      maxTokens: profile?.maxTokens,
      contextWindow: profile?.contextWindow ?? modelRouter?.getContextWindow?.() ?? 0,
      vision: cap.vision,
      visionSource: cap.source,
      visionDeclaration: modelRouter?.getVisionDeclaration?.(),
      visionProbe: probe,
      detail: visionDetail(cap, current, cap.probe),
    },
    runtime,
    storage,
  };
}
