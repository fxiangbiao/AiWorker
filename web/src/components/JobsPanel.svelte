<script lang="ts">
  /**
   * 后台任务面板（Sprint 34，OS 导航「任务」）
   */
  import { API } from "$lib/stores/chat.svelte";
  import { onWsEvent } from "$lib/stores/ws.svelte";
  import { ListChecks, RefreshCw } from "lucide-svelte";

  interface Job {
    id: string;
    agentId: string;
    prompt: string;
    status: "queued" | "running" | "done" | "failed";
    summary: string;
    error?: string;
    finishedAt?: number;
  }

  let jobs = $state<Job[]>([]);
  let loading = $state(false);

  async function load() {
    loading = true;
    try {
      const r = await fetch(`${API}/jobs`);
      if (r.ok) {
        const d = (await r.json()) as { jobs?: Job[] };
        jobs = d.jobs ?? [];
      }
    } catch {
      /* 忽略 */
    }
    loading = false;
  }

  function statusColor(s: string): string {
    switch (s) {
      case "done":
        return "var(--success)";
      case "running":
        return "var(--warn)";
      case "failed":
        return "var(--error)";
      default:
        return "var(--dim)";
    }
  }

  onWsEvent((data) => {
    if (data.type === "job/done") void load();
  });

  void load();
</script>

<div class="jp">
  <div class="jp-head">
    <span class="jp-title">后台任务</span>
    <button class="jp-refresh" title="刷新" onclick={() => void load()}><RefreshCw size={13} /></button>
  </div>

  {#if jobs.length === 0}
    <div class="jp-empty">{loading ? "加载中…" : "暂无任务（/bg 提交）"}</div>
  {:else}
    <div class="jp-list">
      {#each jobs as j (j.id)}
        <div class="jp-item">
          <span class="jp-dot" style:background={statusColor(j.status)}></span>
          <div class="jp-body">
            <div class="jp-prompt">{j.prompt.slice(0, 60)}{j.prompt.length > 60 ? "…" : ""}</div>
            <div class="jp-meta">
              <span style:color={statusColor(j.status)}>{j.status}</span>
              <span>{j.agentId}</span>
            </div>
            {#if j.status === "failed" && j.error}<div class="jp-err">{j.error.slice(0, 80)}</div>{/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .jp { display: flex; flex-direction: column; height: 100%; padding: 10px 12px; gap: 8px; overflow-y: auto; }
  .jp-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 6px; }
  .jp-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; color: var(--dim); }
  .jp-refresh {
    border: none; background: transparent; color: var(--dim); cursor: pointer;
    display: flex; align-items: center; padding: 3px; border-radius: var(--radius-sm);
  }
  .jp-refresh:hover { background: var(--hover-bg); color: var(--primary); }
  .jp-empty { color: var(--dim); font-size: 12px; text-align: center; padding: 24px 0; }
  .jp-list { display: flex; flex-direction: column; gap: 5px; }
  .jp-item { display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .jp-dot { width: 7px; height: 7px; border-radius: 50%; margin-top: 4px; flex-shrink: 0; }
  .jp-body { flex: 1; min-width: 0; }
  .jp-prompt { font-size: 12px; font-weight: 500; word-break: break-all; }
  .jp-meta { font-size: 11px; color: var(--dim); margin-top: 2px; display: flex; gap: 8px; }
  .jp-err { font-size: 11px; color: var(--error); margin-top: 2px; word-break: break-all; }
</style>
