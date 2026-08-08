export interface ChatItem {
  id: string;
  title: string;
  agentId: string;
  turns: number;
  createdAt: number;
}

export const API = "/api/v1";

export interface UIMessage {
  role: "user" | "assistant" | "agent";
  content: string;
  agentId?: string;
  timeline?: TimelineItem[];
  _thinkingActive?: boolean;
  _kind?: "chat" | "plan" | "debate" | "error";
  _steps?: PlanStep[];
  _meta?: { agentA?: string; agentB?: string; failedSteps?: string[] };
  _activeStep?: string;
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

export const store = $state({
  mode: "auto" as string,
  agentId: "default" as string,
  inputMode: "chat" as "chat" | "plan" | "debate",
  chats: [] as ChatItem[],
  activeChatId: null as string | null,
  messages: [] as UIMessage[],
  confirms: [] as ConfirmItem[],
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
  if (s.mode) store.mode = s.mode;
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
  return load<UIMessage[]>("aiworker_msgs_" + id, []);
}

export function saveMessages(id: string, msgs: UIMessage[]) {
  if (id) save("aiworker_msgs_" + id, msgs);
}

/** 从服务器 /sessions 合并会话列表（服务器有而本地没有的补进来） */
export async function syncServerSessions() {
  try {
    const resp = await fetch(`${API}/sessions`);
    if (!resp.ok) return;
    const data = await resp.json();
    const remote: ChatItem[] = (data.sessions || []).map((s: {
      id: string;
      agent_id?: string;
      agentId?: string;
      created_at?: number;
      createdAt?: number;
    }) => ({
      id: s.id,
      title: s.id.slice(0, 12),
      agentId: s.agentId || s.agent_id || "default",
      turns: 0,
      createdAt: s.createdAt || s.created_at || 0,
    }));
    const localIds = new Set(store.chats.map((c) => c.id));
    const merged = [...store.chats];
    for (const r of remote) {
      if (!localIds.has(r.id)) {
        merged.push(r);
        localIds.add(r.id);
      }
    }
    store.chats = merged;
    saveChats(merged);
  } catch {
    /* 服务器离线时静默 */
  }
}

/** 从服务器加载会话消息（本地无缓存时） */
export async function loadRemoteMessages(id: string): Promise<UIMessage[]> {
  try {
    const resp = await fetch(`${API}/sessions/${encodeURIComponent(id)}`);
    if (!resp.ok) return [];
    const data = await resp.json();
    const msgs: UIMessage[] = (data.messages || []).map((m: { role: string; content: string }) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content,
    }));
    saveMessages(id, msgs);
    return msgs;
  } catch {
    return [];
  }
}
