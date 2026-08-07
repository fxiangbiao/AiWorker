export interface ChatItem {
  id: string;
  title: string;
  agentId: string;
  turns: number;
  createdAt: number;
}

export interface UIMessage {
  role: "user" | "assistant" | "agent";
  content: string;
  agentId?: string;
  timeline?: TimelineItem[];
  _thinkingActive?: boolean;
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
  mode: "craft" as string,
  agentId: "default" as string,
  chats: [] as ChatItem[],
  activeChatId: null as string | null,
  messages: [] as UIMessage[],
  diffs: [] as { filePath: string; added: number; removed: number }[],
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
