import { writable } from "svelte/store";
import type { ToolArtifact } from "$lib/artifacts";

export interface ChatItem {
  id: string;
  title: string;
  agentId: string;
  turns: number;
  createdAt: number;
  /** 会话自定义项目目录（Sprint 42；null=默认全局） */
  workingDir?: string | null;
}

export const API = "/api/v1";

/** 消息缓存 key 前缀（版本化：消息结构变化时递增，强制下次重新拉取服务器） */
const MSGS_PREFIX = "aiworker_msgs_v2_";

/**
 * 待定位的工具调用 id（Sprint 50）：产物面板「在对话中查看」会设置它，
 * 折叠的工具分组据此自动展开——否则目标卡片根本不在 DOM 里，定位会退化成"框住整条消息"。
 */
export const focusToolCallId = writable<string>("");

export interface UIMessage {
  role: "user" | "assistant" | "agent";
  content: string;
  agentId?: string;
  timeline?: TimelineItem[];
  /** 服务端消息投影的序号（Sprint 50：用户消息据此映射到回合，做「从这里重新开始」；仅 reload 时可得） */
  seq?: number;
  /** 多模态图片（data URL；Sprint 36）：用户消息附带的图片缩略图 */
  images?: string[];
  _thinkingActive?: boolean;
  _kind?: "chat" | "plan" | "debate" | "gen" | "error";
  /** 生成任务卡片：关联的后台生成 jobId（_kind === "gen"） */
  _genJobId?: string;
  /** 生成卡片动作（generate/update；决定文案与结果展示） */
  _genAction?: "generate" | "update";
  /** 生成卡片所属会话 id（终态持久化时定位消息用；刷新后随消息恢复） */
  _genSessionId?: string;
  /** 生成终态（gen/done|failed|canceled 事件写入消息本身，刷新/重开会话后仍可展示） */
  _genStatus?: "done" | "failed" | "canceled";
  _genResult?: { app?: import("./apps.svelte.js").AppInfo; docPath?: string };
  _genError?: string;
  _steps?: PlanStep[];
  _meta?: { agentA?: string; agentB?: string; failedSteps?: string[] };
  _activeStep?: string;
  /** 技能模式：/技能名 激活的技能（SSE skill_activated 事件写入，助手消息顶部徽标） */
  _skills?: { name: string; description?: string }[];
  /** 本轮用量（Sprint 44：/chat done 下发 turnUsage 写入；reload 时按 GET /sessions usages 回填单次请求值） */
  _usage?: { prompt?: number; completion?: number; total?: number; contextPct?: number; perTurn?: boolean };
}

export interface PlanStep {
  id: string;
  description: string;
  expertId: string;
  dependsOn: string[];
  critical: boolean;
  status?: "pending" | "running" | "done" | "failed" | "skipped";
}

export interface ConfirmItem {
  id: string;
  title: string;
  message: string;
  options: { value: string; label: string }[];
}

export interface AskItem {
  id: string;
  question: string;
  options: string[];
  /** 是否允许多选（复选列表 + 确认选择） */
  multiple?: boolean;
}

export interface TimelineItem {
  type: "thinking" | "tool";
  content?: string;
  open?: boolean;
  name?: string;
  args?: string;
  id?: string;
  result?: boolean;
  duration?: number;
  resultPreview?: string;
  toolName?: string;
  error?: string;
  pending?: boolean;
  artifacts?: ToolArtifact[];
}

/** ask_user 等工具的 args 展示：解析 JSON 显示问题与选项数，避免原始 JSON 刷屏 */
export function toolArgsDisplay(name: string, args: unknown): string {
  if (name === "ask_user") {
    try {
      const parsed = (typeof args === "string" ? JSON.parse(args) : args) as {
        question?: unknown;
        options?: unknown;
        multiple?: unknown;
      } | null;
      const q = typeof parsed?.question === "string" ? parsed.question.trim() : "";
      const n = Array.isArray(parsed?.options) ? parsed.options.length : 0;
      const multi = parsed?.multiple === true;
      if (q) return n > 0 ? `${q}（${n} 个选项${multi ? "，可多选" : ""}）` : q;
    } catch {
      /* 解析失败回退原始 args */
    }
  }
  return typeof args === "string" ? args : JSON.stringify(args);
}

export const store = $state({
  mode: "auto" as string,
  agentId: "default" as string,
  inputMode: "chat" as "chat" | "plan" | "debate" | "forge",
  chats: [] as ChatItem[],
  activeChatId: null as string | null,
  messages: [] as UIMessage[],
  confirms: [] as ConfirmItem[],
  asks: [] as AskItem[],
  diffVersion: 0,
});

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function loadSettings() {
  const s = load<{ mode?: string; agentId?: string }>("aiworker_settings", {});
  if (s.mode && ["ask", "plan", "auto"].includes(s.mode)) store.mode = s.mode;
  if (s.agentId) store.agentId = s.agentId;
}

export function saveSettings() {
  save("aiworker_settings", { mode: store.mode, agentId: store.agentId });
}

export function loadChats() {
  const stored = load<ChatItem[]>("aiworker_chats", []);
  store.chats = stored;
}

export function saveChats(all: ChatItem[]) {
  save("aiworker_chats", all);
}

export function loadMessages(id: string): UIMessage[] {
  return load<UIMessage[]>(MSGS_PREFIX + id, []);
}

export function saveMessages(id: string, msgs: UIMessage[]) {
  if (id) save(MSGS_PREFIX + id, msgs);
}

/** 生成/协作等非对话入口的会话兜底：无活动会话时新建一个（逻辑与 ChatPanel.newChat 一致） */
export function ensureActiveChat(): string {
  if (!store.activeChatId) {
    const id = "c" + Date.now().toString(36);
    store.chats.unshift({ id, title: "新对话", agentId: store.agentId, turns: 0, createdAt: Date.now() });
    store.activeChatId = id;
    store.messages = [];
    saveChats(store.chats);
  }
  return store.activeChatId;
}

/** 会话轮数 +1，首条消息作标题（与 ChatPanel 发送逻辑一致，供非对话入口复用） */
export function bumpChatTurn(text: string): void {
  const chat = store.chats.find((c) => c.id === store.activeChatId);
  if (chat && (!chat.turns || chat.turns === 0)) {
    chat.title = text.slice(0, 50);
    chat.turns = 1;
  } else if (chat) {
    chat.turns = (chat.turns || 0) + 1;
  }
  saveChats(store.chats);
}

/** 从服务器 /sessions 合并会话列表（服务器为轮数/标题事实源；本地无的补进来，按创建时间最新在前） */
export async function syncServerSessions(): Promise<boolean> {
  try {
    const resp = await fetch(`${API}/sessions?limit=1000`); // 全量比对（服务端封顶 1000），避免仅前 50 误删本地仍在的旧会话
    if (!resp.ok) return false;
    const data = await resp.json();
    const remote: ChatItem[] = (data.sessions || [])
      .filter((s: { agentId?: string; agent_id?: string }) => (s.agentId || s.agent_id || "default") !== "appgen") // 应用生成后台会话不展示（过程已在对话流卡片）
      .map((s: {
      id: string;
      agent_id?: string;
      agentId?: string;
      created_at?: number;
      createdAt?: number;
      turnCount?: number;
      firstUserMsg?: string | null;
      summary?: string | null;
      workingDir?: string | null;
    }) => {
      const title = (s.firstUserMsg || s.summary || s.id).slice(0, 50);
      return {
        id: s.id,
        title,
        agentId: s.agentId || s.agent_id || "default",
        turns: s.turnCount ?? 0,
        createdAt: s.createdAt || s.created_at || 0,
        workingDir: s.workingDir ?? null,
      };
    });
    const merged = [...store.chats];
    const remoteById = new Map(remote.map((r) => [r.id, r]));
    const remoteIds = new Set(remote.map((r) => r.id));
    let hadNew = false;
    // 服务器有的会话：更新轮数（服务器为准）；本地没有的补进来
    for (let i = 0; i < merged.length; i++) {
      const remoteItem = remoteById.get(merged[i]!.id);
      if (remoteItem) {
        merged[i] = { ...merged[i]!, turns: remoteItem.turns, workingDir: remoteItem.workingDir };
        remoteById.delete(merged[i]!.id);
      }
    }
    // 本地残留、后端已不存在的会话（如协作工作会话被清理/后端删除的孤儿）→ 移除幽灵条目；
    // 跳过当前活动会话与新建空会话（turns=0，可能尚未上报后端）
    for (let i = merged.length - 1; i >= 0; i--) {
      const c = merged[i]!;
      if (!remoteIds.has(c.id) && c.id !== store.activeChatId && (c.turns ?? 0) > 0) {
        merged.splice(i, 1);
      }
    }
    for (const r of remoteById.values()) {
      merged.push(r);
      hadNew = true;
    }
    // 统一按创建时间降序（最新在前）：TUI 等新产生的会话排到最前，重启后能正确选中
    store.chats = merged.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    saveChats(store.chats);
    return hadNew;
  } catch {
    /* 服务器离线时静默 */
    return false;
  }
}

/** 从服务器加载会话消息（本地无缓存时）。
 * 服务端返回事件回放序列（含 assistant(tool_calls) 与 tool 结果），
 * 这里重建为 UIMessage：assistant 的 tool_calls → timeline 工具卡，tool 结果按 tool_call_id 归属
 */
export async function loadRemoteMessages(id: string): Promise<UIMessage[]> {
  try {
    const resp = await fetch(`${API}/sessions/${encodeURIComponent(id)}`);
    if (!resp.ok) return [];
    const data = await resp.json();
    const msgs: UIMessage[] = [];
    // 待归属的 tool_call_id → 所在 assistant 消息
    const pendingTools: { id: string; msg: UIMessage }[] = [];
    // assistant 单次请求 usage（Sprint 44：与 messages 中 assistant 按出现顺序一一对应）
    const usages = (data.usages as Array<{ promptTokens?: number; completionTokens?: number; totalTokens?: number } | null> | undefined) ?? [];
    let assistantIdx = 0;

    for (const m of data.messages || []) {
      const role = m.role as string;
      if (role === "user") {
        const seq = typeof m.seq === "number" ? m.seq : undefined;
        msgs.push({ role: "user", content: m.content || "", ...(seq !== undefined ? { seq } : {}) });
      } else if (role === "assistant") {
        const um: UIMessage = { role: "assistant", content: m.content || "", timeline: [] };
        const tcs = m.tool_calls as
          | Array<{ id: string; type: string; function: { name: string; arguments: string } }>
          | undefined;
        if (tcs && tcs.length > 0) {
          um.timeline = tcs.map((tc) => ({
            type: "tool",
            name: tc.function.name,
            args: toolArgsDisplay(tc.function.name, tc.function.arguments),
            id: tc.id,
            pending: true,
          }));
          for (const tc of tcs) pendingTools.push({ id: tc.id, msg: um });
        }
        // 单次请求 usage 回填（历史口径：非整轮；tool 调用中间消息也可能带 usage）
        const u = usages[assistantIdx];
        if (u && (u.totalTokens ?? (u.promptTokens ?? 0) + (u.completionTokens ?? 0)) > 0) {
          um._usage = {
            prompt: u.promptTokens ?? 0,
            completion: u.completionTokens ?? 0,
            total: u.totalTokens ?? ((u.promptTokens ?? 0) + (u.completionTokens ?? 0)),
            contextPct: 0,
            perTurn: false,
          };
        }
        assistantIdx++;
        msgs.push(um);
      } else if (role === "tool") {
        const target = pendingTools.find((p) => p.id === m.tool_call_id);
        if (target) {
          const item = target.msg.timeline?.find((t) => t.type === "tool" && t.id === m.tool_call_id);
          if (item) {
            const content = String(m.content || "");
            const failed = content.startsWith("Error:");
            item.result = !failed;
            item.error = failed ? content.slice(6, 300) : undefined;
            item.resultPreview = failed ? undefined : content.slice(0, 300);
            // 工具产物随回载写入时间线（Sprint 50）：产物面板「在对话中查看」依赖它定位卡片
            if (Array.isArray(m.artifacts) && m.artifacts.length > 0) item.artifacts = m.artifacts as ToolArtifact[];
            item.pending = false;
            pendingTools.splice(pendingTools.indexOf(target), 1);
          } else {
            // 无对应 tool_call（异常数据）：作为独立错误消息展示
            msgs.push({ role: "assistant", content: m.content || "", _kind: "error" });
          }
        }
      }
      // 其他角色（system 等）不展示
    }
    saveMessages(id, msgs);
    return msgs;
  } catch {
    return [];
  }
}

/** 删除会话（含本地 + 服务器） */
export async function deleteChat(id: string): Promise<boolean> {
  // 本地聊天列表独立于服务端 session：无论服务端是否 404（本地创建但未发送过消息的会话），都更新本地
  store.chats = store.chats.filter((c) => c.id !== id);
  localStorage.removeItem(`aiworker_msgs_${id}`); // 旧版本缓存（清理）
  localStorage.removeItem(`${MSGS_PREFIX}${id}`);
  if (store.activeChatId === id) {
    store.activeChatId = null;
    store.messages = [];
  }
  saveChats(store.chats);
  try {
    const resp = await fetch(`${API}/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    return resp.ok || resp.status === 404;
  } catch {
    return false;
  }
}

/** 重命名会话（更新本地 + 服务器 summary） */
export async function renameChat(id: string, title: string): Promise<boolean> {
  // 本地立即更新，服务端若不存在该 session（404）则忽略
  const chat = store.chats.find((c) => c.id === id);
  if (chat) {
    chat.title = title;
    saveChats(store.chats);
  }
  try {
    const resp = await fetch(`${API}/sessions/${encodeURIComponent(id)}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    return resp.ok || resp.status === 404;
  } catch {
    return false;
  }
}

/** 导出会话为 Markdown 并触发下载 */
export async function exportChat(id: string, fallbackTitle: string): Promise<void> {
  try {
    const resp = await fetch(`${API}/sessions/${encodeURIComponent(id)}/export`);
    if (!resp.ok) return;
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fallbackTitle || id}.md`;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    /* 忽略 */
  }
}
