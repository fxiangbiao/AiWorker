<script lang="ts">
  import { onMount } from "svelte";
  import { API, store } from "$lib/stores/chat.svelte";

  interface DiffLine {
    type: "add" | "del" | "ctx";
    text: string;
  }
  interface DiffFile {
    path: string;
    added: number;
    removed: number;
    lines: DiffLine[];
  }
  interface DiffSession {
    sessionId: string;
    files: DiffFile[];
    createdAt: number;
    updatedAt: number;
  }

  let loading = $state(false);
  let sessions: DiffSession[] = $state([]);
  let selected: DiffFile | null = $state(null);
  let listWidth = $state<number | null>(null); // null = 默认 20% (1:4)

  function startListDrag(e: PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = listWidth ?? 0.25;
    const panelEl = e.currentTarget as HTMLElement;
    const total = panelEl.parentElement?.clientWidth ?? 800;
    const onMove = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
      const ratio = Math.min(Math.max(startW + delta / total, 0.1), 0.5);
      listWidth = ratio;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  onMount(() => load());
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    void store.diffVersion;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(load, 400);
  });

  function load() {
    loading = true;
    fetch(`${API}/diffs`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        const list: DiffSession[] = (d.sessions || []).sort((a: DiffSession, b: DiffSession) => (b.updatedAt || 0) - (a.updatedAt || 0));
        sessions = list;
        if (sessions.length > 0 && sessions[0].files.length > 0 && !selected) {
          selected = sessions[0].files[0];
        }
      })
      .catch(() => { sessions = []; })
      .finally(() => { loading = false; });
  }

  function basename(p: string): string {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }

  function fmtTime(ts: number): string {
    if (!ts) return "";
    const d = new Date(ts);
    const today = new Date();
    const isToday = d.toDateString() === today.toDateString();
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    if (isToday) return `${h}:${m}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${h}:${m}`;
  }
</script>

<div class="diff-body">
  <div class="diff-list" style:width={listWidth ? `${listWidth * 100}%` : "20%"}>
    <div class="dl-title">变更文件</div>
    {#if loading}
      <div class="dl-empty">加载中...</div>
    {:else if sessions.length === 0}
      <div class="dl-empty">暂无文件变更</div>
    {:else}
      {#each sessions as s}
        <div class="dl-session">
          <span class="dl-sid">{s.sessionId.slice(0, 8)}...</span>
          <span class="dl-stime">{fmtTime(s.updatedAt)}</span>
        </div>
        {#each s.files as f}
          <div
            class="dl-file"
            class:active={selected?.path === f.path}
            title={f.path}
            onclick={() => (selected = f)}
            onkeydown={(e) => e.key === "Enter" && (selected = f)}
            role="button"
            tabindex="0"
          >
            <span class="dl-name" title={f.path}>{basename(f.path)}</span>
            <span class="dl-add">+{f.added}</span>
            <span class="dl-rem">-{f.removed}</span>
          </div>
        {/each}
      {/each}
    {/if}
  </div>

  <div class="diff-resizer" onpointerdown={startListDrag}></div>

  <div class="diff-detail">
    {#if selected}
      <div class="dd-title">{basename(selected.path)}</div>
      <div class="dd-path">{selected.path}</div>
      <div class="dd-lines">
        {#each selected.lines as ln, i (i)}
          <div class="dd-line" class:add={ln.type === "add"} class:del={ln.type === "del"}>
            <span class="dd-no">{i + 1}</span>
            <span class="dd-sign">{ln.type === "add" ? "+" : ln.type === "del" ? "-" : " "}</span>
            <span class="dd-text">{ln.text}</span>
          </div>
        {/each}
      </div>
    {:else}
      <div class="dd-empty">选择左侧文件查看变更</div>
    {/if}
  </div>
</div>

<style>
  .diff-body { display: flex; gap: 8px; flex: 1; min-height: 200px; }
  .diff-list {
    width: 20%;
    overflow-y: auto;
    flex-shrink: 0;
    min-width: 0;
  }
  .diff-resizer {
    width: 5px;
    cursor: col-resize;
    background: transparent;
    flex-shrink: 0;
    transition: background .15s;
  }
  .diff-resizer:hover { background: var(--primary-light); }
  .dl-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--dim);
    margin-bottom: 8px;
    text-transform: uppercase;
    letter-spacing: .5px;
  }
  .dl-empty, .dd-empty { font-size: 12px; color: var(--dim); padding: 16px 0; text-align: center; }
  .dl-session { font-size: 10px; color: var(--dim); margin: 8px 0 4px; display: flex; justify-content: space-between; align-items: center; }
  .dl-sid { font-weight: 600; }
  .dl-stime { color: var(--primary); }
  .dl-file {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 12px;
    margin-bottom: 3px;
  }
  .dl-file:hover { background: var(--hover-bg); }
  .dl-file.active { background: var(--primary-light); }
  .dl-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dl-add { color: var(--success); font-weight: 600; font-size: 11px; }
  .dl-rem { color: var(--error); font-weight: 600; font-size: 11px; }
  .diff-detail { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
  .dd-title { font-size: 12px; font-weight: 600; word-break: break-all; }
  .dd-path { font-size: 10px; color: var(--dim); margin-bottom: 8px; word-break: break-all; }
  .dd-lines {
    font-family: var(--font-mono);
    font-size: 11px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: auto;
    flex: 1;
  }
  .dd-line { display: flex; gap: 8px; padding: 1px 8px; white-space: pre-wrap; word-break: break-all; }
  .dd-line.add { background: rgba(34, 161, 232, .08); }
  .dd-line.del { background: rgba(232, 84, 107, .08); }
  .dd-no { color: var(--dim); width: 28px; text-align: right; flex-shrink: 0; }
  .dd-sign { width: 12px; flex-shrink: 0; }
  .dd-line.add .dd-sign { color: var(--success); }
  .dd-line.del .dd-sign { color: var(--error); }
  .dd-text { flex: 1; }
</style>
