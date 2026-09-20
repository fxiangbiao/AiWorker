/**
 * 应用与进程 store（Sprint 34/35）
 * /api/v1/apps /api/v1/processes 拉取 + WS 订阅（app/* process/*）实时刷新
 * 窗口体系（Sprint 35）：openWindows 打开集合 + winStates 位置持久化（localStorage）
 */
import { writable, derived, get } from "svelte/store";
import { API, store, saveMessages, loadMessages, ensureActiveChat, bumpChatTurn, type UIMessage } from "./chat.svelte";
import { onWsEvent } from "./ws.svelte";

export type AppSurface = "panel" | "float" | "widget";

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
  ui?: { surface?: AppSurface };
}

export type OsProcess = {
  kind: "agent" | "app" | "job" | "subagent";
  pid: string;
  status: string;
  startedAt?: number;
  endedAt?: number;
  /** kind === "agent"：智能体 id */
  agentId?: string;
  /** kind === "app"：应用 id（gen-xxx） */
  appId?: string;
  /** kind === "job"：后台任务 id */
  jobId?: string;
  /** kind === "subagent"：子智能体 id（Sprint 52） */
  subagentId?: string;
} & Record<string, unknown>;

export interface AppWinState {
  surface: AppSurface;
  x: number;
  y: number;
  w: number;
  h: number;
  pinned: boolean;
}

export const apps = writable<AppInfo[]>([]);
export const processes = writable<OsProcess[]>([]);
export const processStats = writable<{ agent: number; app: number; job: number; subagent: number }>({ agent: 0, app: 0, job: 0, subagent: 0 });

/**
 * 子智能体按"是否还在干活"拆分（Sprint 52 收尾）：
 * idle 是**已结束但可续接**的终态、进程条目会保留，直接拿 `processStats.subagent` 计数会显示成"还在运行"
 */
export const activeSubagents = derived(
  processes,
  ($p) => $p.filter((x) => x.kind === "subagent" && (x.status === "running" || x.status === "queued" || x.status === "starting")).length,
);
export const resumableSubagents = derived(processes, ($p) => $p.filter((x) => x.kind === "subagent" && x.status === "idle").length);
/** 资源仪表（Sprint 42 A3）：全局 token 占用（/processes 附带） */
export const processResources = writable<{ tokens: { total: number; prompt: number; completion: number } } | null>(null);

/** 已打开窗口的应用 id 集合（app/generated 或用户打开 → true；关闭 → false）——仅当前会话，不跨刷新恢复 */
export const openWindows = writable<Record<string, boolean>>({});
/** 窗口状态（位置/尺寸/形态/置顶），localStorage 持久化 appwin-<id> */
export const winStates = writable<Record<string, AppWinState>>({});
/** 右侧面板当前 Tab（Sprint 50：文件变更+文档预览+回滚 合并为「产物」；权限已迁到 设置→安全，故只剩两个） */
export const rightTab = writable<"artifacts" | "apps">("artifacts");
/** 右侧面板可见性（默认关闭；新生成应用/文档时自动展开到对应 Tab） */
export const rightPanelVisible = writable(false);
/** 待打开的文档（`<root>:<rel>`）——产物面板据此在列表里选中该文档 */
export const docViewer = writable<string | null>(null);
/** 右侧「应用」面板当前选中的应用 id（左侧应用列表点击/启动时联动切换） */
export const previewAppId = writable("");
/** 左侧导航当前 Tab（对话/应用/进程/任务；供启动台等跨组件切换） */
export const sidebarNav = writable<"chat" | "apps" | "processes" | "jobs">("chat");

function loadWinState(id: string): AppWinState {
  const def: AppWinState = { surface: "float", x: 120, y: 90, w: 420, h: 320, pinned: false };
  try {
    const raw = localStorage.getItem(`appwin-${id}`);
    if (raw) return { ...def, ...(JSON.parse(raw) as Partial<AppWinState>) };
  } catch {
    /* 忽略 */
  }
  return def;
}

function persistWinState(id: string): void {
  const s = get(winStates)[id];
  if (!s) return;
  try {
    localStorage.setItem(`appwin-${id}`, JSON.stringify(s));
  } catch {
    /* 忽略 */
  }
}

export function openAppWindow(id: string, app?: AppInfo): void {
  openWindows.update((m) => ({ ...m, [id]: true }));
  winStates.update((m) => {
    if (m[id]) return m;
    // 按应用声明的形态初始化窗口（panel 停靠右侧预览 / widget 透明小尺寸 / float 悬浮）；
    // 优先用传入的 app（生成完成瞬间 apps 列表可能尚未刷新，避免 ui.surface 丢失回退）
    const surface = app?.ui?.surface ?? get(apps).find((a) => a.id === id)?.ui?.surface ?? "panel";
    const def: AppWinState =
      surface === "widget"
        ? { surface: "widget", x: 80, y: 80, w: 320, h: 360, pinned: false }
        : surface === "float"
          ? loadWinState(id)
          : { surface: "panel", x: 0, y: 0, w: 0, h: 0, pinned: false };
    return { ...m, [id]: def };
  });
}

/** 打开/启动应用：统一停靠右侧「应用」面板展示（不直接弹浮窗），面板折叠时自动展开，并选中该应用 */
export function openAppInPreview(id: string, app?: AppInfo): void {
  setAppSurface(id, "panel");
  openAppWindow(id, app);
  previewAppId.set(id);
  docViewer.set(null);
  rightPanelVisible.set(true);
  rightTab.set("apps");
}

/** 切换应用展示形态：panel=停靠右侧预览 / float=浮窗（拖拽缩放）/ widget=透明小部件 */
export function setAppSurface(id: string, surface: AppSurface): void {
  winStates.update((m) => {
    const cur = m[id] ?? loadWinState(id);
    const next: AppWinState = { ...cur, surface };
    if (surface === "float" && (next.w < 280 || next.h < 180)) {
      next.w = 420;
      next.h = 320;
    }
    if (surface === "float" && next.x === 0 && next.y === 0) {
      next.x = 120;
      next.y = 90;
    }
    // widget 不可缩放，尺寸恒为默认（低于默认值则提升，覆盖旧版 280×280 持久化）
    if (surface === "widget" && (next.w < 320 || next.h < 360)) {
      next.w = 320;
      next.h = 360;
    }
    const out = { ...m, [id]: next };
    setTimeout(() => persistWinState(id), 0);
    return out;
  });
}

export function closeAppWindow(id: string): void {
  openWindows.update((m) => ({ ...m, [id]: false }));
}

export function setWinState(id: string, patch: Partial<AppWinState>): void {
  winStates.update((m) => {
    const cur = m[id] ?? loadWinState(id);
    const next = { ...cur, ...patch };
    const out = { ...m, [id]: next };
    setTimeout(() => persistWinState(id), 0);
    return out;
  });
}

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
    const d = (await r.json()) as {
      processes?: OsProcess[];
      stats?: { agent: number; app: number; job: number; subagent?: number };
      resources?: { tokens: { total: number; prompt: number; completion: number } };
    };
    processes.set(d.processes ?? []);
    if (d.stats) processStats.set({ subagent: 0, ...d.stats });
    if (d.resources) processResources.set(d.resources);
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

/** 迭代更新应用：优先异步队列（返回 jobId，进度经 gen/* WS 事件推送），兼容同步回退（直接返回 app） */
export async function updateApp(
  id: string,
  description: string,
): Promise<{ ok: boolean; jobId?: string; error?: string; app?: AppInfo }> {
  try {
    const r = await fetch(`${API}/apps/${encodeURIComponent(id)}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description }),
    });
    const d = (await r.json()) as { ok?: boolean; jobId?: string; error?: string; app?: AppInfo };
    return { ok: d.ok === true, jobId: d.jobId, error: d.error, app: d.app };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export interface GenerateResult {
  ok: boolean;
  app?: AppInfo;
  error?: string;
  docPath?: string;
}

export interface GenJobState {
  status: "queued" | "running" | "done" | "failed" | "canceled";
  step?: string;
  pct?: number;
  result?: GenerateResult;
  error?: string;
  /** 当前轨迹详情（如 "index.html 完成（41 行）"） */
  detail?: string;
  /** 轨迹时间线（时间 + 文案），保留最近 N 条 */
  trace: { at: number; text: string }[];
}

/** 生成任务进度（按 jobId）；websocket gen/* 事件驱动 */
export const genJobs = writable<Record<string, GenJobState>>({});

/** 异步生成：入队立即返回 jobId（连接零阻塞） */
export async function generateApp(
  description: string,
  type?: string,
  surface?: AppSurface,
  sessionId?: string,
): Promise<{ ok: boolean; jobId?: string; error?: string }> {
  try {
    const r = await fetch(`${API}/apps/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description, type, surface, sessionId }),
    });
    const d = (await r.json()) as { ok?: boolean; jobId?: string; error?: string };
    if (!r.ok || !d.ok) return { ok: false, error: d.error ?? "生成失败" };
    return { ok: true, jobId: d.jobId };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** 取消生成（仅排队中可取消） */
export async function cancelGenerate(jobId: string): Promise<boolean> {
  try {
    const r = await fetch(`${API}/apps/gen/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
    const d = (await r.json()) as { ok?: boolean };
    return d.ok === true;
  } catch {
    return false;
  }
}

/** 聊天流生成卡片（统一入口）：插入用户消息 + 生成状态卡片并提交后台任务。
 * GenWizard 按钮与应用工坊模式共用，保证生成过程统一以聊天流实时状态卡片呈现；
 * 进度经 genJobs store（WS gen/* 事件）驱动，由 GenCard 组件渲染。
 */
export async function spawnGenCard(
  description: string,
  opts: { type?: string; surface?: AppSurface; sessionId?: string; userText?: string } = {},
): Promise<{ ok: boolean; jobId?: string; error?: string }> {
  const sessionId = ensureActiveChat();
  const userText = opts.userText ?? description;
  store.messages.push({ role: "user", content: userText });
  // 注意：必须经 store.messages 代理引用回写（Svelte 5 深响应），直接改局部对象不触发更新
  const cardIdx = store.messages.push({
    role: "assistant",
    content: "已提交生成任务，正在创建…",
    _kind: "gen",
    _genSessionId: sessionId,
  }) - 1;
  bumpChatTurn(userText);
  saveMessages(sessionId, store.messages);
  const r = await generateApp(description, opts.type, opts.surface, opts.sessionId ?? sessionId);
  if (store.activeChatId !== sessionId) return r; // 期间已切走会话：放弃回写
  const card = store.messages[cardIdx];
  if (card && card._kind === "gen") {
    if (r.ok && r.jobId) {
      card._genJobId = r.jobId;
    } else {
      card.content = `生成提交失败：${r.error ?? "未知错误"}`;
    }
  }
  saveMessages(sessionId, store.messages);
  return r;
}

/** 应用迭代更新卡片（与生成同流程）：插入用户消息 + 状态卡片，异步队列后台执行。
 * 进度经 genJobs store（WS gen/* 事件）驱动，由 GenCard 渲染；终态写回卡片消息持久化。
 */
export async function spawnUpdateCard(
  app: AppInfo,
  description: string,
): Promise<{ ok: boolean; jobId?: string; error?: string }> {
  const sessionId = ensureActiveChat();
  const userText = `更新应用「${app.name}」（v${app.version}）：${description}`;
  store.messages.push({ role: "user", content: userText });
  // 注意：必须经 store.messages 代理引用回写（Svelte 5 深响应），直接改局部对象不触发更新
  const cardIdx = store.messages.push({
    role: "assistant",
    content: "已提交更新任务，正在重写…",
    _kind: "gen",
    _genSessionId: sessionId,
    _genAction: "update",
  }) - 1;
  bumpChatTurn(userText);
  saveMessages(sessionId, store.messages);
  const r = await updateApp(app.id, description);
  if (store.activeChatId !== sessionId) return r; // 期间已切走会话：放弃回写
  const card = store.messages[cardIdx];
  if (card && card._kind === "gen") {
    if (r.ok && r.jobId) {
      card._genJobId = r.jobId;
    } else if (r.ok && r.app) {
      // 同步回退（无队列）：直接写终态
      card._genStatus = "done";
      card._genResult = { app: r.app };
      card.content = `✓ 应用已更新：${r.app.name}`;
    } else {
      card.content = `更新提交失败：${r.error ?? "未知错误"}`;
    }
  }
  saveMessages(sessionId, store.messages);
  return r;
}

/** WS 订阅：应用/进程事件实时刷新 + 窗口自动打开 */
export function initAppsWs(): void {
  onWsEvent((data) => {    const type = data.type;
    if (typeof type !== "string") return;
    if (type === "app/generated") {
      void loadApps();
      const genApp = data.app as AppInfo | undefined;
      if (typeof data.appId === "string" && genApp?.type === "app") {
        openAppWindow(data.appId, genApp);
        // 新生成的 app 类型应用默认展示在右侧「应用」面板
        rightPanelVisible.set(true);
        rightTab.set("apps");
      }
    } else if (type === "app/started") {
      void loadApps();
      // 启动统一停靠右侧「应用」面板展示（不直接弹浮窗/小部件），面板折叠时自动展开
      const app = data.app as AppInfo | undefined;
      const id = app?.id ?? (typeof data.appId === "string" ? data.appId : undefined);
      if (typeof id === "string" && app?.type === "app") {
        openAppInPreview(id, app);
      }
    } else if (type === "app/stopped" || type === "app/destroyed" || type === "app/failed") {
      // 停止/销毁/失败 → 关闭窗口（浮窗/小部件/停靠预览均消失）
      const id = (data.app as { id?: string } | null)?.id ?? data.appId;
      if (typeof id === "string") closeAppWindow(id);
      void loadApps();
      void loadProcesses();
    } else if (type === "app/window") {
      const appId = data.appId;
      if (typeof appId !== "string") return;
      if (data.action === "close") closeAppWindow(appId);
      else if (data.action === "focus") openAppInPreview(appId);
    } else if (type === "app/updated") {
      void loadApps();
    } else if (type.startsWith("gen/")) {
      handleGenEvent(type, data);
    } else if (type.startsWith("app/")) {
      void loadApps();
      // 应用生命周期变化（生成/启动/停止/销毁）同步刷新进程列表，避免遗漏运行中的应用
      if (type === "app/started" || type === "app/stopped" || type === "app/generated" || type === "app/installed" || type === "app/destroyed" || type === "app/failed") {
        void loadProcesses();
      }
    } else if (type.startsWith("process/")) {
      void loadProcesses();
    }
  });
  // 初始拉取生成任务列表：刷新后恢复进行中任务的进度与已完成卡片的终态
  void loadGenJobs();
}

/** 生成任务进度事件（gen/*）→ genJobs store + 完成后处理 */
function handleGenEvent(type: string, data: Record<string, unknown>): void {
  const jobId = data.jobId;
  if (typeof jobId !== "string") return;
  genJobs.update((m) => {
    const cur = m[jobId] ?? { status: "queued" as const, trace: [] as { at: number; text: string }[] };
    const next: GenJobState = { ...cur, trace: cur.trace ?? [] };
    if (type === "gen/queued") next.status = "queued";
    else if (type === "gen/running") next.status = "running";
    else if (type === "gen/progress") {
      next.status = "running";
      next.step = typeof data.step === "string" ? data.step : cur.step;
      next.pct = typeof data.pct === "number" ? data.pct : cur.pct;
      const detail = typeof data.detail === "string" ? data.detail : undefined;
      if (detail) {
        next.detail = detail;
        const at = typeof data.at === "number" ? data.at : Date.now();
        next.trace = [...next.trace, { at, text: detail }].slice(-8);
      }
    } else if (type === "gen/done") {
      next.status = "done";
      next.pct = 100;
      next.result = data.result as GenerateResult | undefined;
      // 完成：应用自动停靠预览（清文档态并选中新应用）/ 文档打开预览面板
      if (next.result?.app && next.result.app.type === "app") {
        openAppInPreview(next.result.app.id, next.result.app);
      }
      if (next.result?.docPath) {
        const rel = next.result.docPath.replace(/\\/g, "/").split("/docs/").pop() ?? next.result.docPath;
        docViewer.set(`session:${rel}`);
        rightPanelVisible.set(true);
        rightTab.set("artifacts");
      }
      void loadApps();
    } else if (type === "gen/failed") {
      next.status = "failed";
      next.error = typeof data.error === "string" ? data.error : cur.error;
    } else if (type === "gen/canceled") {
      next.status = "canceled";
    }
    return { ...m, [jobId]: next };
  });
  // 终态持久化到卡片消息（刷新/重开会话后仍展示），并保持 ws 订阅可用
  if (type === "gen/done" || type === "gen/failed" || type === "gen/canceled") {
    syncGenCard(jobId);
  }
}

/** 生成终态 → 写回卡片消息并持久化（按 _genSessionId 定位消息，跨会话也可恢复） */
function syncGenCard(jobId: string): void {
  const job = get(genJobs)[jobId];
  if (!job || (job.status !== "done" && job.status !== "failed" && job.status !== "canceled")) return;
  let card: UIMessage | undefined = store.messages.find((m) => m._genJobId === jobId);
  let msgs: UIMessage[] = store.messages;
  let sid = store.activeChatId ?? "";
  if (!card) {
    // 卡片不在当前会话：按全部本地会话定位（loadMessages 返回副本，改后整体存回）
    for (const c of store.chats) {
      const list = loadMessages(c.id);
      const hit = list.find((m) => m._genJobId === jobId);
      if (hit) {
        card = hit;
        msgs = list;
        sid = c.id;
        break;
      }
    }
  }
  if (!card || card._genStatus) return;
  card._genStatus = job.status;
  card._genResult = job.result
    ? { app: job.result.app ?? undefined, docPath: job.result.docPath }
    : undefined;
  card._genError = job.error;
  const isUpdate = card._genAction === "update";
  if (job.status === "done") {
    card.content = job.result?.app
      ? isUpdate
        ? `✓ 应用已更新：${job.result.app.name} v${job.result.app.version ?? ""}`
        : `✓ 应用已生成：${job.result.app.name}`
      : job.result?.docPath
        ? "✓ 文档已生成"
        : card.content;
  } else if (job.status === "failed") {
    card.content = `✗ ${isUpdate ? "更新" : "生成"}失败：${job.error ?? "未知错误"}`;
  } else {
    card.content = "已取消";
  }
  if (sid) saveMessages(sid, msgs);
}

/** 拉取服务端生成任务列表（刷新后恢复 genJobs：进行中继续显示进度，终态补全卡片） */
export async function loadGenJobs(): Promise<void> {
  try {
    const r = await fetch(`${API}/apps/gen`);
    if (!r.ok) return;
    const d = (await r.json()) as {
      jobs?: Array<{ id: string; status: string; step?: string; progressPct?: number; result?: GenerateResult; error?: string }>;
    };
    const map: Record<string, GenJobState> = {};
    for (const j of d.jobs ?? []) {
      map[j.id] = {
        status: (j.status as GenJobState["status"]) ?? "queued",
        step: j.step,
        pct: j.status === "done" ? 100 : j.progressPct,
        result: j.result,
        error: j.error,
        trace: [],
      };
    }
    genJobs.set(map);
  } catch {
    /* 服务离线时静默 */
  }
}
