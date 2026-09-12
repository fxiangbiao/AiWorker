/**
 * WebSocket 全局实时通道（/api/v1/ws）
 * 职责：接收服务端主动推送（会话同步/状态），断线自动重连（指数退避）
 * 说明：chat/plan/debate 的单次任务事件仍走 SSE（发起标签页以 SSE 为准，
 *       避免双通道重复渲染）；WS 仅消费无 SSE 对应的同步事件。
 */
import { serverOnline } from "./status";
import { syncServerSessions, loadRemoteMessages, store } from "./chat.svelte";
import { stream } from "./stream.svelte";

let ws: WebSocket | null = null;
let retryMs = 1000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

type WsHandler = (data: Record<string, unknown>) => void;
const handlers = new Set<WsHandler>();

export function onWsEvent(h: WsHandler): () => void {
  handlers.add(h);
  return () => {
    handlers.delete(h);
  };
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/api/v1/ws`);
  ws.onopen = () => {
    serverOnline.set(true);
    retryMs = 1000;
  };
  ws.onmessage = (ev) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    for (const h of handlers) {
      try {
        h(data);
      } catch {
        /* 单处理器异常不影响其他 */
      }
    }
  };
  ws.onclose = () => {
    serverOnline.set(false);
    ws = null;
    retryTimer = setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 30000);
  };
  ws.onerror = () => {
    ws?.close();
  };
}

export function initWs(): void {
  if (typeof window === "undefined") return;
  onWsEvent((data) => {
    const type = data.type;
    if (type === "session/update") {
      // 会话元数据变更（创建/重命名/删除/新消息）→ 刷新会话列表
      void syncServerSessions();
      // 回滚（Sprint 48）：当前会话被回滚（可能来自 TUI 或其他标签页）→ 重新拉取消息投影
      const sid = data.sessionId;
      if (data.kind === "rewind" && typeof sid === "string" && sid && store.activeChatId === sid && !stream.sending) {
        void loadRemoteMessages(sid).then((msgs) => {
          if (store.activeChatId === sid && !stream.sending) store.messages = msgs;
        });
      }
      return;
    }
    // chat 回合结束（done 事件 SSE 与 WS 双写）→ 其他标签页同步消息
    if (type === "done" && !stream.sending) {
      const sessionId = data.sessionId;
      if (typeof sessionId === "string" && sessionId && store.activeChatId === sessionId) {
        void loadRemoteMessages(sessionId).then((msgs) => {
          if (store.activeChatId === sessionId && !stream.sending) store.messages = msgs;
        });
      }
    }
  });
  connect();
}
