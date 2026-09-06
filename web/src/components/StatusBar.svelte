<script lang="ts">
  import { onMount } from "svelte";
  import { fmtN } from "$lib/utils/format";
  import { currentModel, totalTokens, promptTokens, completionTokens, contextWindow, serverOnline } from "$lib/stores/status";
  import { apps, processStats, loadApps, loadProcesses, initAppsWs } from "$lib/stores/apps.svelte";
  import { Cpu, Box } from "lucide-svelte";

  /** 上下文窗口展示：≥1M 显 M（如 1M），≥1000 显 k（如 128k） */
  function fmtWin(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
    return String(n);
  }
  /** 运行中的应用数（含系统插件；业务语义） */
  const runningApps = $derived($apps.filter((a) => a.status === "running").length);
  /** 运行中的进程总数（Agent 会话 + 应用 + 后台任务；来自进程注册表） */
  const procCount = $derived($processStats.agent + $processStats.app + $processStats.job);

  onMount(() => {
    void loadApps();
    void loadProcesses();
    initAppsWs();
  });
</script>

<div class="statusbar">
  <div class="sb-item"><span class="sb-dot" class:online={$serverOnline}></span></div>
  <div class="sb-item" title="进程级全局累计（本次运行所有会话）">
    model: {$currentModel}{$contextWindow ? ` · 窗口 ${fmtWin($contextWindow)}` : ""}
  </div>
  <div class="sb-item" title="进程级全局累计 token（本次运行，跨会话；本轮/会话用量见气泡与轨迹）">
    全局 tok: {fmtN($totalTokens)}（↑{fmtN($promptTokens)} ↓{fmtN($completionTokens)}）
  </div>
  <div class="sb-item" title="运行中的进程 / 运行中的应用">
    <Cpu size={11} />{procCount}
    <Box size={11} />{runningApps}
  </div>
</div>

<style>
  .statusbar {
    height: 30px;
    background: var(--surface);
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    padding: 0 16px;
    gap: 20px;
    font-size: 11px;
    color: var(--dim);
    flex-shrink: 0;
  }
  .sb-item { display: flex; align-items: center; gap: 5px; }
  .sb-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); }
  .sb-dot.online { background: var(--success); }
</style>
