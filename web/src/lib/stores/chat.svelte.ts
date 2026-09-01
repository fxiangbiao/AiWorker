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

export interface UIMessage {
  role: "user" | "assistant" | "agent";
  content: string;
  agentId?: string;
  timeline?: TimelineItem[];
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
    const resp = await fetch(`${API}/sessions`);
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
    let hadNew = false;
    // 服务器有的会话：更新轮数（服务器为准）；本地没有的补进来
    for (let i = 0; i < merged.length; i++) {
      const remoteItem = remoteById.get(merged[i]!.id);
      if (remoteItem) {
        merged[i] = { ...merged[i]!, turns: remoteItem.turns, workingDir: remoteItem.workingDir };
        remoteById.delete(merged[i]!.id);
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

    for (const m of data.messages || []) {
      const role = m.role as string;
      if (role === "user") {
        msgs.push({ role: "user", content: m.content || "" });
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
