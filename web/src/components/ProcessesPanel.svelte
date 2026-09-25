<script lang="ts">
  /**
   * 进程视图面板（Sprint 34）
   * Agent/App/Job 三类进程实时列表（WS 事件驱动）；打开时拉取最新
   */
  import { onMount } from "svelte";
  import { processes, processStats, processResources, loadProcesses, apps, activeSubagents, resumableSubagents } from "$lib/stores/apps.svelte";
  import { Brain, Box, ListChecks, RefreshCw, Gauge, Bot } from "lucide-svelte";

  function fmtTime(ts: number): string {
    const d = new Date(ts);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
  }

  function fmtNum(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  /** 进程运行时长（进行中 = 至今；已结束 = 起止差） */
  function duration(p: { startedAt?: number; endedAt?: number }): string {
    const end = p.endedAt ?? Date.now();
    if (typeof p.startedAt !== "number" || end < p.startedAt) return "";
    const s = Math.round((end - p.startedAt) / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}m${r > 0 ? `${r}s` : ""}`;
  }

  const KIND_LABEL = { agent: "Agent", app: "应用", job: "任务", subagent: "子智能体" } as const;
  const KIND_ICON = { agent: Brain, app: Box, job: ListChecks, subagent: Bot } as const;

  /** 状态中文化：idle 是"已结束但可续接"的终态，不是"还在跑" */
  const STATUS_LABEL: Record<string, string> = {
    starting: "启动中",
    running: "运行中",
    queued: "排队中",
    idle: "已结束 · 可续接",
    done: "已完成",
    failed: "失败",
    stopped: "已停止",
  };

  function statusColor(status: string): string {
    switch (status) {
      case "running":
      case "done":
        return "var(--success)";
      case "starting":
      case "queued":
        return "var(--warn)";
      case "failed":
        return "var(--error)";
      default:
        return "var(--dim)";
    }
  }

  function pidShort(pid: string): string {
    const parts = pid.split("-");
    return parts.slice(0, 2).join("-");
  }

  /** 应用进程：优先展示应用名（appId 为 gen-xxx 不易识别），附带短 id */
  function appLabel(appId: string): string {
    const app = $apps.find((a) => a.id === appId);
    if (app?.name) return `${app.name}（${appId.slice(0, 12)}）`;
    return appId;
  }

  onMount(() => {
    void loadProcesses();
  });
</script>

<div class="pp">
  <div class="pp-head">
    <span class="pp-title">进程</span>
    <button class="pp-refresh" title="刷新" onclick={() => void loadProcesses()}><RefreshCw size={13} /></button>
  </div>

  <div class="pp-stats">
    <span class="pp-stat"><Brain size={12} /> {$processStats.agent}</span>
    <span class="pp-stat"><Box size={12} /> {$processStats.app}</span>
    <span class="pp-stat"><ListChecks size={12} /> {$processStats.job}</span>
    {#if $activeSubagents > 0}
      <span class="pp-stat" title="活动中的后台子智能体（运行/排队）"><Bot size={12} /> {$activeSubagents}</span>
    {/if}
    {#if $resumableSubagents > 0}
      <span class="pp-stat pp-idle" title="已结束但保留会话，可 send_message 续接"><Bot size={12} /> 可续接 {$resumableSubagents}</span>
    {/if}
    {#if $processResources}
      <span class="pp-stat pp-res" title="本次运行累计 token（全局）"><Gauge size={12} /> tok {fmtNum($processResources.tokens.total)} <span class="pp-res-sub">入 {fmtNum($processResources.tokens.prompt)} · 出 {fmtNum($processResources.tokens.completion)}</span></span>
    {/if}
  </div>

  {#if $processes.length === 0}
    <div class="pp-empty">暂无运行中的进程</div>
  {:else}
    <div class="pp-list">
      {#each $processes as p (p.pid)}
        {@const Icon = KIND_ICON[p.kind] ?? ListChecks}
        <div class="pp-item" class:pp-item-idle={p.kind === "subagent" && p.status === "idle"}>
          <span class="pp-ico" style:color={statusColor(p.status)}><Icon size={14} /></span>
          <div class="pp-body">
            <div class="pp-name">
              {KIND_LABEL[p.kind] ?? p.kind}
              {#if p.kind === "agent" && p.agentId}<span class="pp-sub">{p.agentId}</span>{/if}
              {#if p.kind === "app" && p.appId}<span class="pp-sub app-name">{appLabel(p.appId)}</span>{/if}
              {#if p.kind === "job" && p.jobId}<span class="pp-sub">{String(p.jobId).slice(0, 18)}</span>{/if}
              {#if p.kind === "subagent" && p.subagentId}<span class="pp-sub">{String(p.subagentId).slice(0, 18)}</span>{/if}
            </div>
            <div class="pp-meta">
              <span style:color={statusColor(p.status)}>{STATUS_LABEL[p.status] ?? p.status}</span>
              {#if typeof p.startedAt === "number"}
                <span>{fmtTime(p.startedAt)}</span>
              {/if}
              {#if duration(p)}
                <span class="pp-dur">{duration(p)}</span>
              {/if}
              <span class="pp-pid">{pidShort(p.pid)}</span>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .pp { display: flex; flex-direction: column; height: 100%; padding: 10px 12px; gap: 8px; overflow-y: auto; }
  .pp-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 6px; }
  .pp-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; color: var(--dim); }
  .pp-refresh {
    border: none; background: transparent; color: var(--dim); cursor: pointer;
    display: flex; align-items: center; padding: 3px; border-radius: var(--radius-sm);
  }
  .pp-refresh:hover { background: var(--hover-bg); color: var(--primary); }
  .pp-stats { display: flex; gap: 12px; padding: 0 4px 6px; font-size: 12px; color: var(--dim); }
  .pp-stat { display: flex; align-items: center; gap: 4px; }
  .pp-idle { color: var(--dim); }
  .pp-res { margin-left: auto; color: var(--primary); }
  .pp-res-sub { color: var(--dim); font-weight: 400; }
  .pp-dur { color: var(--warn); }
  .pp-empty { color: var(--dim); font-size: 12px; text-align: center; padding: 24px 0; }
  .pp-list { display: flex; flex-direction: column; gap: 5px; }
  .pp-item {
    display: flex; gap: 10px; align-items: flex-start;
    padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  }
  .pp-ico { display: flex; align-items: center; padding-top: 1px; }
  .pp-item-idle { opacity: .65; }
  .pp-body { flex: 1; min-width: 0; }
  .pp-name { font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .pp-sub { font-size: 11px; color: var(--dim); font-weight: 400; }
  .pp-sub.app-name { color: var(--text); font-weight: 500; }
  .pp-meta { font-size: 11px; color: var(--dim); margin-top: 2px; display: flex; gap: 8px; align-items: center; }
  .pp-pid { color: var(--primary); font-weight: 500; }
</style>
