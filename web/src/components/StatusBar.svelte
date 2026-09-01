<script lang="ts">
  import { onMount } from "svelte";
  import { fmtN } from "$lib/utils/format";
  import { currentModel, totalTokens, promptTokens, completionTokens, serverOnline, PRICING } from "$lib/stores/status";
  import { apps, processStats, loadApps, loadProcesses, initAppsWs } from "$lib/stores/apps.svelte";
  import { Cpu, Box } from "lucide-svelte";

  /** 费用 = prompt×单价 + completion×单价（每 1M token），不再用总 token 混算 */
  const cost = $derived((($promptTokens || 0) * PRICING.prompt + ($completionTokens || 0) * PRICING.completion) / 1e6);
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
  <div class="sb-item">model: {$currentModel}</div>
  <div class="sb-item">tokens: {fmtN($totalTokens)}</div>
  <span>cost: ¥{cost.toFixed(4)}</span>
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
