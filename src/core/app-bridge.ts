/**
 * 宿主能力桥（Sprint 35 补丁 C）— 由宿主注入 iframe，应用无需自带
 * 注入时机：server 静态路由返回 webapp index.html 时，在 </head> 前内联本脚本。
 * 应用通过 window.__AIWORKER_BRIDGE__ 使用能力（storage/notify/llm/fs/http），
 * 无 terminal；postMessage 到宿主的 origin 由 AppHost 校验。
 */

export const APP_BRIDGE_SNIPPET = `;(() => {
  const pend = new Map(); let seq = 1;
  const REQ_TIMEOUT = 30000;
  // 响应只接受来自宿主窗口（同源 iframe 内 window.parent 身份校验，防止伪造 bridge:res）
  window.addEventListener("message", (ev) => {
    if (ev.source !== window.parent) return;
    const d = ev.data;
    if (!d || d.type !== "bridge:res" || !pend.has(d.id)) return;
    const p = pend.get(d.id); pend.delete(d.id);
    clearTimeout(p.timer);
    d.error ? p.reject(new Error(d.error)) : p.resolve(d.result);
  });
  const req = (method, params = {}) => new Promise((resolve, reject) => {
    const id = seq++;
    const timer = setTimeout(() => {
      if (!pend.has(id)) return;
      pend.delete(id);
      reject(new Error("能力调用超时（宿主无响应）: " + method));
    }, REQ_TIMEOUT);
    pend.set(id, { resolve, reject, timer });
    window.parent.postMessage({ id, type: "bridge:req", method, params }, "*");
  });
  window.__AIWORKER_BRIDGE__ = {
    storage: { get: (k) => req("storage.get", { key: k }), set: (k, v) => req("storage.set", { key: k, value: v }) },
    notify: (title, body) => req("notify", { title, body }),
    llm: { call: (opts) => req("llm.call", opts) },
    fs: { read: (p) => req("fs.read", { path: p }), write: (p, c) => req("fs.write", { path: p, content: c }) },
    http: { fetch: (url, opts) => req("http.fetch", { url, opts }) },
  };
})();`;
