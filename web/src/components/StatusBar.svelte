<script lang="ts">
  import { onMount } from "svelte";
  import { fmtN } from "$lib/utils/format";
  import { currentModel, totalTokens, promptTokens, completionTokens, contextWindow, serverOnline } from "$lib/stores/status";
  import { apps, processStats, loadApps, loadProcesses, initAppsWs, activeSubagents } from "$lib/stores/apps.svelte";
  import { openSettings } from "$lib/stores/shell.svelte";
  import { API } from "$lib/stores/chat.svelte";
  import { Cpu, Box, ShieldCheck } from "lucide-svelte";

  /** 上下文窗口展示：≥1M 显 M（如 1M），≥1000 显 k（如 128k） */
  function fmtWin(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
    return String(n);
  }
  /** 运行中的应用数（含系统插件；业务语义） */
  const runningApps = $derived($apps.filter((a) => a.status === "running").length);
  /** 运行中的进程总数（Agent 会话 + 应用 + 任务 + **活动的**子智能体；来自进程注册表） */
  const procCount = $derived($processStats.agent + $processStats.app + $processStats.job + $activeSubagents);

  /**
   * 权限模式徽章（Sprint 50 / IA 重构）：权限面板从右栏搬进「设置 → 安全」后，
   * 这里提供一个随时可见、一点即达的入口——否则用户会找不到它。
   * 只读展示 + 项目级规则条数，避免为了显示一个数字去拉全量规则详情。
   */
  let permMode = $state("");
  let permRules = $state(0);

  onMount(() => {
    void loadApps();
    void loadProcesses();
    initAppsWs();
    void fetch(`${API}/permissions`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { mode?: string; projectCount?: number } | null) => {
        if (!d) return;
        permMode = d.mode ?? "";
        permRules = d.projectCount ?? 0;
      })
      .catch(() => {});
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
  <button class="sb-item sb-btn" title="权限规则与沙箱（设置 → 安全）" onclick={() => openSettings("security")}>
    <ShieldCheck size={11} />权限 {permMode || "—"}{permRules > 0 ? ` · 项目级 ${permRules}` : ""}
  </button>
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
  .sb-btn {
    border: 1px solid transparent;
    background: transparent;
    color: var(--dim);
    font-size: 11px;
    cursor: pointer;
    padding: 1px 6px;
    border-radius: var(--radius-sm);
  }
  .sb-btn:hover { color: var(--primary); background: var(--hover-bg); border-color: var(--border); }
  .sb-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); }
  .sb-dot.online { background: var(--success); }
</style>
