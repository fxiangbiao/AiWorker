/**
 * 应用与进程 store（Sprint 34）
 * /api/v1/apps /api/v1/processes 拉取 + WS 订阅（app/* process/*）实时刷新
 */
import { writable } from "svelte/store";
import { API } from "./chat.svelte";
import { onWsEvent } from "./ws.svelte";

export interface AppInfo {
  id: string;
  type: "tool" | "skill" | "agent" | "service" | "app";
  name: string;
  version: string;
  description: string;
  entry: string;
  permissions: string[];
  tools: string[];
  status: string;
  autostart: boolean;
  originSessionId?: string;
  lastError?: string;
  crashCount?: number;
  plugin?: boolean;
}

export type OsProcess = {
  kind: "agent" | "app" | "job";
  pid: string;
  status: string;
  startedAt?: number;
  endedAt?: number;
} & Record<string, unknown>;

export const apps = writable<AppInfo[]>([]);
export const processes = writable<OsProcess[]>([]);
export const processStats = writable<{ agent: number; app: number; job: number }>({ agent: 0, app: 0, job: 0 });

export async function loadApps(): Promise<void> {
  try {
    const r = await fetch(`${API}/apps`);
    if (!r.ok) return;
    const d = (await r.json()) as { apps?: AppInfo[] };
    apps.set(d.apps ?? []);
  } catch {
    /* 服务器未启动忽略 */
  }
}

export async function loadProcesses(): Promise<void> {
  try {
    const r = await fetch(`${API}/processes`);
    if (!r.ok) return;
    const d = (await r.json()) as { processes?: OsProcess[]; stats?: { agent: number; app: number; job: number } };
    processes.set(d.processes ?? []);
    if (d.stats) processStats.set(d.stats);
  } catch {
    /* 忽略 */
  }
}

export async function appAction(id: string, action: "start" | "stop" | "destroy"): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${API}/apps/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    const d = (await r.json()) as { ok?: boolean; error?: string };
    return { ok: d.ok === true, error: d.error };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** WS 订阅：应用/进程事件实时刷新 */
export function initAppsWs(): void {
  onWsEvent((data) => {
    const type = data.type;
    if (typeof type !== "string") return;
    if (type.startsWith("app/")) {
      void loadApps();
    } else if (type.startsWith("process/")) {
      void loadProcesses();
    }
  });
}
