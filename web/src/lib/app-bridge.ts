/**
 * 能力桥宿主侧处理器（Sprint 35）— 供浮窗（AppHost）与停靠预览（AppPreviewPanel）共用
 * 沙箱 iframe（无 allow-same-origin）发来的消息 origin 为 "null"，无法用 origin 校验，
 * 改用 ev.source === iframe.contentWindow 身份校验（安全性等价）
 */
import { API } from "$lib/stores/chat.svelte";

/**
 * 注册 iframe 能力桥消息处理（bridge:req → POST /apps/:id/bridge → bridge:res 回传）
 * @returns 清理函数（组件卸载时调用）
 */
export function setupBridgeHandler(iframeEl: HTMLIFrameElement | null, appId: string): () => void {
  const onMessage = (ev: MessageEvent) => {
    if (!iframeEl || ev.source !== iframeEl.contentWindow) return;
    const d = ev.data as { type?: string; id?: number; method?: string; params?: Record<string, unknown> };
    if (!d || typeof d !== "object" || d.type !== "bridge:req" || !d.method) return;
    fetch(`${API}/apps/${encodeURIComponent(appId)}/bridge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: d.method, params: d.params ?? {} }),
    })
      .then((r) => r.json())
      .then((resp) => {
        iframeEl.contentWindow?.postMessage(
          { id: d.id, type: "bridge:res", result: (resp as { result?: unknown }).result, error: (resp as { error?: string }).error },
          location.origin,
        );
      })
      .catch((err) => {
        iframeEl.contentWindow?.postMessage({ id: d.id, type: "bridge:res", error: (err as Error).message }, location.origin);
      });
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
