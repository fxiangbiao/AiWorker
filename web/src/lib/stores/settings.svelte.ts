/**
 * 设置数据（Sprint 50 / IA 重构）：`/config` 与 `/sandbox` 两个写面的**唯一**实现
 *
 * 为什么收成 store：模型与交互两个 tab 都要读写 `/config`，安全与工作区两个 tab 都要读写 `/sandbox`。
 * 各组件自己 fetch 就会出现"同一份配置两套加载/错误处理/实时生效"的分叉（本项目已因这类分叉返工过两次）。
 *
 * 写面协议（与后端一致）：
 * - `/config`：`{ field, value }` 单项设置；需要 `x-aiworker-token`（跨站 403 / 缺 token 401）
 * - `/sandbox`：整体提交若干沙箱字段（目录必须绝对路径）；保存后**立即生效**（每次工具调用现读磁盘）
 */

import { writable } from "svelte/store";
import { API } from "./chat.svelte";

function token(): string {
  return typeof window !== "undefined" ? (window.__AIWORKER_TOKEN__ ?? "") : "";
}

export interface ConfigState {
  model: string;
  availableModels: Array<{ key: string; model: string; provider?: string }>;
  runtimeConfig: { profileKey?: string; temperature?: number; maxTokens?: number };
  iterations: { default: number };
  thinking: boolean;
  skillEvo: boolean;
  appVersion: string;
}

export interface SandboxState {
  writePath: string;
  readPath: string;
  exists: boolean;
  policy: {
    enabled: boolean;
    allowDirs: string[];
    allowWriteDirs: string[];
    allowReadDirs: string[];
    denyCommands: string[];
    stripSecretEnv: boolean;
  };
  /** 留空的根按工作目录回退后的**真正生效**范围 */
  effective: { allowDirs: string[]; allowWriteDirs: string[]; allowReadDirs: string[] };
}

export interface DeviceStatus {
  runtime?: {
    node: string;
    platform: string;
    arch: string;
    cpus: number;
    freeMemGB: number;
    totalMemGB: number;
    pid: number;
    uptimeSec: number;
    cpuModel: string;
    dataDir: string;
    dataDirWritable: boolean;
  };
  storage?: { ok: boolean; sqlite: string; fts5: boolean; dbPath: string; dbPresent: boolean; dbSizeKb: number; error?: string };
  model: {
    current: string;
    provider?: string;
    baseURL?: string;
    adapter?: string;
    thinking?: boolean;
    temperature?: number | null;
    maxTokens?: number | null;
    contextWindow?: number;
    vision: boolean;
    visionSource?: "probe" | "config" | "unknown";
    detail: string;
    visionProbe?: { model: string; supported: boolean | null; latencyMs: number; at: number; stale?: boolean } | null;
  };
}

export const configState = writable<ConfigState | null>(null);
export const configError = writable("");
export const configNotice = writable("");

export const sandboxState = writable<SandboxState | null>(null);
export const sandboxError = writable("");
export const sandboxNotice = writable("");

export const deviceStatus = writable<DeviceStatus | null>(null);
export const deviceError = writable("");
export const probeBusy = writable(false);

export async function loadConfigState(): Promise<void> {
  configError.set("");
  try {
    const resp = await fetch(`${API}/config`);
    if (!resp.ok) {
      configState.set(null);
      configError.set(resp.status === 503 ? "服务端未提供配置接口（需 --server 模式）" : `加载失败（${resp.status}）`);
      return;
    }
    configState.set((await resp.json()) as ConfigState);
  } catch {
    configState.set(null);
    configError.set("无法连接服务端");
  }
}

/** 单项写入（写侧字段名为规范名：model / temperature / maxTokens / thinking / skillEvo / addModel / reset …）
 *  注意与读侧 `runtimeConfig.profileKey` 区分：写侧用 "model"，后端两个名字都收（别名兼容） */
export async function applyConfigField(field: string, value: unknown): Promise<boolean> {
  configError.set("");
  configNotice.set("");
  try {
    const resp = await fetch(`${API}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-aiworker-token": token() },
      body: JSON.stringify({ field, value }),
    });
    const data = (await resp.json()) as { ok?: boolean; error?: string; state?: ConfigState };
    if (!resp.ok || !data.ok) {
      configError.set(`设置失败：${data.error ?? resp.status}`);
      return false;
    }
    if (data.state) configState.set(data.state);
    else await loadConfigState();
    configNotice.set("已保存");
    return true;
  } catch {
    configError.set("无法连接服务端");
    return false;
  }
}

export async function loadSandbox(): Promise<void> {
  sandboxError.set("");
  try {
    const resp = await fetch(`${API}/sandbox`);
    if (!resp.ok) {
      sandboxState.set(null);
      sandboxError.set(`加载失败（${resp.status}）`);
      return;
    }
    sandboxState.set((await resp.json()) as SandboxState);
  } catch {
    sandboxState.set(null);
    sandboxError.set("无法连接服务端");
  }
}

/** 提交沙箱字段（部分更新语义：只传要改的键）；成功后回带最新快照 */
export async function saveSandbox(patch: Record<string, unknown>): Promise<boolean> {
  sandboxError.set("");
  sandboxNotice.set("");
  try {
    const resp = await fetch(`${API}/sandbox`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-aiworker-token": token() },
      body: JSON.stringify(patch),
    });
    const data = (await resp.json()) as { ok?: boolean; error?: string } & Partial<SandboxState>;
    if (!resp.ok || !data.ok) {
      sandboxError.set(`保存失败：${data.error ?? resp.status}`);
      if (data.policy) sandboxState.set(data as SandboxState);
      return false;
    }
    sandboxState.set(data as SandboxState);
    sandboxNotice.set("已保存，下一次工具调用即生效（无需重启）");
    return true;
  } catch {
    sandboxError.set("无法连接服务端");
    return false;
  }
}

export async function loadDeviceStatus(): Promise<void> {
  deviceError.set("");
  try {
    const resp = await fetch(`${API}/devices`);
    if (!resp.ok) {
      deviceStatus.set(null);
      deviceError.set(`设备状态不可用（${resp.status}）`);
      return;
    }
    deviceStatus.set((await resp.json()) as DeviceStatus);
  } catch {
    deviceStatus.set(null);
    deviceError.set("无法连接服务端");
  }
}

/** 实测图片能力（一次极小图片请求写进 <dataDir>/device-probe.json，随后刷新设备状态） */
export async function probeModelVision(): Promise<boolean> {
  probeBusy.set(true);
  deviceError.set("");
  try {
    const resp = await fetch(`${API}/devices/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-aiworker-token": token() },
      body: JSON.stringify({ kind: "model-vision" }),
    });
    const data = (await resp.json()) as { ok?: boolean; error?: string };
    if (!resp.ok || data.ok === false) {
      deviceError.set(`检测失败：${data.error ?? resp.status}`);
      return false;
    }
    await loadDeviceStatus();
    return true;
  } catch {
    deviceError.set("无法连接服务端");
    return false;
  } finally {
    probeBusy.set(false);
  }
}
