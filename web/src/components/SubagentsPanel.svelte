<script lang="ts">
  /**
   * 子智能体面板（Sprint 52 T6b）：控制台「资源」分组，只读为主 + 追问/中断/关闭
   */
  import { onMount } from "svelte";
  import { API } from "$lib/stores/chat.svelte";
  import { onWsEvent } from "$lib/stores/ws.svelte";
  import { Bot, RefreshCw, Send, Square, X } from "lucide-svelte";

  interface Sub {
    id: string;
    agentId: string;
    sessionId: string;
    parentSessionId: string | null;
    status: "queued" | "running" | "idle" | "failed";
    abortRequested: boolean;
    readOnly: boolean;
    task: string;
    rounds: number;
    pending: string[];
    summary: string;
    usage: { prompt: number; completion: number };
    lastError?: string;
    startedAt?: number;
    finishedAt?: number;
  }

  const TOKEN = typeof window !== "undefined" ? (window.__AIWORKER_TOKEN__ ?? "") : "";

  let subs = $state<Sub[]>([]);
  let loading = $state(false);
  /** 读取错误与动作错误分开：否则动作失败后紧接的刷新会把提示清掉（用户看不到 401/404/队列已满） */
  let loadError = $state("");
  let actionError = $state("");
  let detailId = $state<string | null>(null);
  let draft = $state("");
  let busy = $state("");

  async function load() {
    loading = true;
    try {
      const r = await fetch(`${API}/subagents`);
      if (r.ok) {
        const d = (await r.json()) as { subagents?: Sub[] };
        subs = d.subagents ?? [];
        loadError = "";
      } else {
        loadError = `读取失败（HTTP ${r.status}）`;
      }
    } catch {
      loadError = "无法连接服务端";
    }
    loading = false;
  }

  async function act(id: string, kind: "interrupt" | "close" | "send", message?: string) {
    busy = `${id}:${kind}`;
    actionError = "";
    try {
      const purge = kind === "close";
      const r =
        kind === "send"
          ? await fetch(`${API}/subagents/${encodeURIComponent(id)}/messages`, {
              method: "POST",
              headers: { "content-type": "application/json", "x-aiworker-token": TOKEN },
              body: JSON.stringify({ message }),
            })
          : await fetch(`${API}/subagents/${encodeURIComponent(id)}${purge ? "?purge=1" : ""}`, {
              method: "DELETE",
              headers: { "x-aiworker-token": TOKEN },
            });
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        actionError = d.error ?? `操作失败（HTTP ${r.status}）`;
      } else if (kind === "send") {
        draft = "";
      }
      await load();
    } catch {
      actionError = "无法连接服务端";
    }
    busy = "";
  }

  function statusColor(s: string): string {
    switch (s) {
      case "running":
        return "var(--warn)";
      case "idle":
        return "var(--success)";
      case "failed":
        return "var(--error)";
      default:
        return "var(--dim)";
    }
  }

  function statusLabel(s: Sub): string {
    if (s.status === "idle") return "可续接";
    if (s.status === "queued") return "排队中";
    if (s.status === "running") return s.abortRequested ? "中断中" : "运行中";
    return "失败";
  }

  function fmtNum(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }

  function duration(s: Sub): string {
    const end = s.finishedAt ?? Date.now();
    if (typeof s.startedAt !== "number" || end < s.startedAt) return "";
    const sec = Math.round((end - s.startedAt) / 1000);
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    return `${m}m${sec % 60 > 0 ? `${sec % 60}s` : ""}`;
  }

  function shortId(id: string | null): string {
    return id ? id.slice(0, 14) : "—";
  }

  const active = $derived(subs.filter((s) => s.status === "running" || s.status === "queued").length);

  /** 运行中的轮次/token 无 WS 事件可依，仅在存在活动条目时轻量轮询；WS 订阅随面板卸载退订 */
  onMount(() => {
    void load();
    const timer = setInterval(() => {
      if (subs.some((s) => s.status === "running" || s.status === "queued")) void load();
    }, 3000);
    const unsub = onWsEvent((d) => {
      const type = typeof d.type === "string" ? d.type : "";
      if (type.startsWith("subagent/") || type === "process/start" || type === "process/end") void load();
    });
    return () => {
      clearInterval(timer);
      unsub();
    };
  });

  function toggleDetail(id: string) {
    detailId = detailId === id ? null : id;
    draft = "";
  }
</script>

<div class="sa">
  <div class="sa-head">
    <span class="sa-title"><Bot size={13} /> 子智能体</span>
    <span class="sa-stat">
      {#if active > 0}<span class="sa-live">{active} 个活动</span>{/if}
      <span>{subs.length} 条记录</span>
    </span>
    <button class="sa-refresh" title="刷新" onclick={() => void load()}><RefreshCw size={13} /></button>
  </div>

  {#if loadError || actionError}
    <div class="sa-error">{actionError || loadError}</div>
  {/if}

  {#if subs.length === 0}
    <div class="sa-empty">{loading ? "加载中…" : "暂无子智能体（主智能体经 spawn_agent 派生，或 POST /api/v1/subagents）"}</div>
  {:else}
    <div class="sa-list">
      {#each subs as s (s.id)}
        <div class="sa-item">
          <span class="sa-dot" style:background={statusColor(s.status)}></span>
          <div class="sa-body">
            <div class="sa-name">
              <span style:color={statusColor(s.status)}>{statusLabel(s)}</span>
              <span class="sa-agent">{s.agentId}</span>
              <span class="sa-id">{s.id}</span>
              {#if s.readOnly}<span class="sa-badge">只读</span>{/if}
            </div>
            <div class="sa-meta">
              <span>{s.rounds} 轮</span>
              <span>tok 入 {fmtNum(s.usage.prompt)} · 出 {fmtNum(s.usage.completion)}</span>
              {#if s.pending.length > 0}<span>待处理 {s.pending.length}</span>{/if}
              {#if duration(s)}<span>{duration(s)}</span>{/if}
              <span class="sa-parent" title={`父会话 ${s.parentSessionId ?? "无"}`}>父 {shortId(s.parentSessionId)}</span>
            </div>
            {#if s.task}<div class="sa-task">{s.task.slice(0, 160)}{s.task.length > 160 ? "…" : ""}</div>{/if}
            {#if s.summary}<div class="sa-summary">{s.summary.slice(0, 160)}{s.summary.length > 160 ? "…" : ""}</div>{/if}
            {#if s.lastError}<div class="sa-err">{s.lastError.slice(0, 160)}</div>{/if}
            {#if detailId === s.id}
              <div class="sa-detail">
                <div class="sa-kv"><span>会话</span><code>{s.sessionId}</code></div>
                <div class="sa-kv"><span>父会话</span><code>{s.parentSessionId ?? "—"}</code></div>
                {#if s.pending.length > 0}
                  <div class="sa-kv"><span>队列</span><code>{s.pending.join(" | ").slice(0, 200)}</code></div>
                {/if}
              </div>
            {/if}
          </div>
          <div class="sa-actions">
            <button class="sa-btn" title="详情" onclick={() => toggleDetail(s.id)}>…</button>
            {#if s.status === "idle" || s.status === "running"}
              <button
                class="sa-btn"
                title="追问（运行中入队，空闲起新一轮）"
                disabled={busy !== ""}
                onclick={() => {
                  detailId = s.id;
                  draft = "";
                }}><Send size={12} /></button>
            {/if}
            {#if s.status === "running" || s.status === "queued"}
              <button
                class="sa-btn danger"
                title="中断当前轮（保留会话，可续接）"
                disabled={busy !== ""}
                onclick={() => void act(s.id, "interrupt")}><Square size={12} /></button>
            {/if}
            <button
              class="sa-btn danger"
              title="关闭并释放槽位（不可续接）"
              disabled={busy !== ""}
              onclick={() => void act(s.id, "close")}><X size={12} /></button>
          </div>
        </div>
        {#if detailId === s.id && (s.status === "idle" || s.status === "running")}
          <div class="sa-send">
            <input
              class="sa-input"
              placeholder={s.status === "running" ? "追加一轮（入队，当前轮结束后消费）" : "追问（立即起新一轮）"}
              bind:value={draft}
              onkeydown={(e) => e.key === "Enter" && draft.trim() && void act(s.id, "send", draft.trim())}
            />
            <button
              class="sa-send-btn"
              disabled={!draft.trim() || busy !== ""}
              onclick={() => void act(s.id, "send", draft.trim())}>发送</button>
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .sa { display: flex; flex-direction: column; gap: 8px; padding: 2px 14px 12px 0; }
  .sa-head { display: flex; align-items: center; gap: 10px; padding: 2px 0 4px; }
  .sa-title { display: flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; color: var(--dim); }
  .sa-stat { display: flex; gap: 10px; font-size: 11px; color: var(--dim); }
  .sa-live { color: var(--warn); }
  .sa-refresh {
    margin-left: auto; border: none; background: transparent; color: var(--dim); cursor: pointer;
    display: flex; align-items: center; padding: 3px; border-radius: var(--radius-sm);
  }
  .sa-refresh:hover { background: var(--hover-bg); color: var(--primary); }
  .sa-error { font-size: 11px; color: var(--error); }
  .sa-empty { color: var(--dim); font-size: 12px; padding: 24px 0; text-align: center; }
  .sa-list { display: flex; flex-direction: column; gap: 5px; }
  .sa-item {
    display: flex; gap: 8px; align-items: flex-start;
    padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  }
  .sa-dot { width: 7px; height: 7px; border-radius: 50%; margin-top: 5px; flex-shrink: 0; }
  .sa-body { flex: 1; min-width: 0; }
  .sa-name { font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .sa-agent { color: var(--text); font-weight: 500; }
  .sa-id { font-size: 11px; color: var(--primary); font-weight: 400; }
  .sa-badge {
    font-size: 10px; font-weight: 500; color: var(--dim);
    border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0 4px;
  }
  .sa-meta { font-size: 11px; color: var(--dim); margin-top: 2px; display: flex; gap: 8px; flex-wrap: wrap; }
  .sa-parent { color: var(--dim); }
  .sa-summary { font-size: 11px; color: var(--text); margin-top: 3px; word-break: break-word; }
  .sa-task { font-size: 11px; color: var(--dim); margin-top: 3px; word-break: break-word; }
  .sa-err { font-size: 11px; color: var(--error); margin-top: 3px; word-break: break-word; }
  .sa-detail { margin-top: 5px; display: flex; flex-direction: column; gap: 2px; }
  .sa-kv { font-size: 11px; color: var(--dim); display: flex; gap: 6px; }
  .sa-kv code { color: var(--text); word-break: break-all; }
  .sa-actions { display: flex; gap: 3px; flex-shrink: 0; }
  .sa-btn {
    width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
    border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface); color: var(--dim); font-size: 11px; cursor: pointer;
  }
  .sa-btn:hover:not(:disabled) { background: var(--hover-bg); color: var(--primary); }
  .sa-btn:disabled { opacity: .4; cursor: not-allowed; }
  .sa-btn.danger:hover:not(:disabled) { color: var(--error); border-color: var(--error); }
  .sa-send { display: flex; gap: 6px; padding: 0 0 2px 15px; }
  .sa-input {
    flex: 1; min-width: 0; padding: 6px 9px; font-family: var(--font-ui); font-size: 12px;
    background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm);
  }
  .sa-input:focus { outline: none; border-color: var(--primary); }
  .sa-send-btn {
    padding: 6px 12px; font-family: var(--font-ui); font-size: 12px; font-weight: 600;
    background: var(--primary); color: #fff; border: none; border-radius: var(--radius-sm); cursor: pointer;
  }
  .sa-send-btn:hover:not(:disabled) { background: var(--primary-hover); }
  .sa-send-btn:disabled { opacity: .5; cursor: not-allowed; }
</style>
