<script lang="ts">
  /**
   * 进化引擎面板（Sprint 39 第一期）
   * 观察指标仪表 + 提案列表（采纳/拒绝）+ 运行观察并提议
   */
  import { onMount } from "svelte";
  import { API } from "$lib/stores/chat.svelte";
  import { onWsEvent } from "$lib/stores/ws.svelte";
  import { Sparkles, RefreshCw, Check, X, BrainCircuit } from "lucide-svelte";

  interface ToolStat {
    name: string;
    calls: number;
    failed: number;
    successRate: number;
    avgDurationMs: number;
    topErrors: { err: string; count: number }[];
  }
  interface Observation {
    windowStart: number;
    windowEnd: number;
    toolStats: ToolStat[];
    completion: { sessions: number; ok: number; rate: number; avgTurns: number };
    repeatedTasks: { pattern: string; count: number; examples: string[] }[];
    userInterventions: number;
    generated: { apps: number; docs: number; updates: number };
  }
  interface Proposal {
    id: string;
    type: string;
    title: string;
    reason: string;
    risk: "low" | "medium" | "high";
    status: "pending" | "adopted" | "rejected";
    createdAt: number;
  }

  let obs = $state<Observation | null>(null);
  let proposals = $state<Proposal[]>([]);
  let loading = $state(false);
  let busy = $state(false);
  let msg = $state<{ kind: "ok" | "err" | "info"; text: string } | null>(null);

  const TYPE_LABEL: Record<string, string> = {
    "new-skill": "新技能",
    "new-tool": "新工具",
    "new-app": "新应用",
    "config-change": "配置变更",
    "tool-fix": "工具修复",
    "prompt-fix": "提示词修复",
  };
  const RISK_LABEL: Record<string, string> = { low: "低", medium: "中", high: "高" };
  const STATUS_LABEL: Record<string, string> = { pending: "待确认", adopted: "已采纳", rejected: "已拒绝" };

  function pct(v?: number): string {
    return v === undefined ? "-" : `${Math.round(v * 100)}%`;
  }

  async function loadObserve() {
    loading = true;
    msg = null;
    try {
      const r = await fetch(`${API}/evolution/observe`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      obs = (await r.json()) as Observation;
    } catch {
      obs = null;
      msg = { kind: "err", text: "观察数据加载失败（进化引擎可能未启用）" };
    } finally {
      loading = false;
    }
  }

  async function loadProposals() {
    try {
      const r = await fetch(`${API}/evolution/proposals`);
      if (r.ok) proposals = ((await r.json()) as { proposals: Proposal[] }).proposals ?? [];
    } catch {
      /* 静默：提案列表失败不阻断 */
    }
  }

  async function runPropose() {
    busy = true;
    msg = null;
    try {
      const r = await fetch(`${API}/evolution/propose`, { method: "POST" });
      const d = (await r.json()) as { ok: boolean; proposals?: Proposal[]; limited?: boolean; error?: string };
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      if (d.limited) {
        msg = { kind: "info", text: "今日提案已达上限（3 条），明天再来" };
      } else {
        msg = {
          kind: "ok",
          text: (d.proposals?.length ?? 0) > 0 ? `已生成 ${d.proposals?.length} 条提案` : "暂无值得提议的改进点",
        };
      }
      await loadObserve();
      await loadProposals();
    } catch (e) {
      msg = { kind: "err", text: (e as Error).message };
    } finally {
      busy = false;
    }
  }

  async function act(id: string, action: "adopt" | "reject") {
    msg = null;
    try {
      const r = await fetch(`${API}/evolution/proposals/${id}/${action}`, { method: "POST" });
      const d = (await r.json()) as { ok: boolean; jobId?: string; detail?: string; error?: string };
      if (!r.ok || !d.ok) {
        msg = { kind: "err", text: d.error ?? `操作失败（HTTP ${r.status}）` };
      } else {
        msg = {
          kind: "ok",
          text: action === "adopt" ? `已采纳${d.jobId ? `，生成任务 ${d.jobId}（进度见右侧「应用」Tab）` : ""}` : "已拒绝",
        };
      }
      await loadProposals();
    } catch (e) {
      msg = { kind: "err", text: (e as Error).message };
    }
  }

  let unsubWs: (() => void) | null = null;

  onMount(() => {
    loadObserve();
    loadProposals();
    unsubWs = onWsEvent((d) => {
      const t = (d as { type?: string }).type ?? "";
      if (t.startsWith("evolution/") || t === "gen/done" || t === "gen/failed") {
        loadProposals();
        loadObserve();
      }
    });
  });

  $effect(() => {
    return () => unsubWs?.();
  });
</script>

<div class="evo-panel">
  <div class="evo-toolbar">
    <button class="evo-btn" onclick={runPropose} disabled={busy}>
      <Sparkles size={14} /> {busy ? "分析中…" : "运行观察并提议"}
    </button>
    <button class="evo-btn evo-ghost" onclick={loadObserve} disabled={loading}>
      <RefreshCw size={14} /> 刷新
    </button>
    {#if msg}
      <span class="evo-msg evo-{msg.kind}">{msg.text}</span>
    {/if}
  </div>

  <div class="evo-section">
    <div class="evo-title"><BrainCircuit size={14} /> 观察指标（最近 7 天）</div>
    {#if loading}
      <div class="evo-empty">加载中…</div>
    {:else if !obs}
      <div class="evo-empty">暂无观察数据（进化引擎未启用或窗口内无活动）</div>
    {:else}
      <div class="evo-cards">
        <div class="evo-card">
          <div class="evo-card-val">{obs.completion.sessions}</div>
          <div class="evo-card-label">会话 · 完成率 {pct(obs.completion.rate)} · 均 {obs.completion.avgTurns} 轮</div>
        </div>
        <div class="evo-card">
          <div class="evo-card-val">{obs.toolStats.reduce((s, t) => s + t.calls, 0)}</div>
          <div class="evo-card-label">工具调用（{obs.toolStats.length} 种）</div>
        </div>
        <div class="evo-card">
          <div class="evo-card-val">{obs.userInterventions}</div>
          <div class="evo-card-label">用户干预</div>
        </div>
        <div class="evo-card">
          <div class="evo-card-val">{obs.generated.apps + obs.generated.docs + obs.generated.updates}</div>
          <div class="evo-card-label">生成（应用 {obs.generated.apps} · 文档 {obs.generated.docs} · 更新 {obs.generated.updates}）</div>
        </div>
      </div>

      {#if obs.toolStats.length > 0}
        <div class="evo-sub">工具成功率（低亮红）</div>
        <div class="evo-tool-list">
          {#each obs.toolStats.slice(0, 8) as t}
            <div class="evo-tool">
              <span class="evo-tool-name">{t.name}</span>
              <span class="evo-tool-bar">
                <span class="evo-tool-fill" style="width:{Math.max(2, t.successRate * 100)}%;background:{t.successRate >= 0.9 ? "var(--success)" : t.successRate >= 0.6 ? "var(--warn)" : "var(--error)"}"></span>
              </span>
              <span class="evo-tool-num" style="color:{t.successRate >= 0.9 ? "var(--success)" : t.successRate >= 0.6 ? "var(--warn)" : "var(--error)"}">{pct(t.successRate)}</span>
              <span class="evo-tool-meta">{t.calls} 次 · 失败 {t.failed} · 均 {t.avgDurationMs}ms</span>
            </div>
            {#if t.topErrors.length > 0}
              <div class="evo-errors">
                {#each t.topErrors as e}
                  <span class="evo-err-chip" title={e.err}>{e.err.slice(0, 30)}{e.err.length > 30 ? "…" : ""} ×{e.count}</span>
                {/each}
              </div>
            {/if}
          {/each}
        </div>
      {/if}

      {#if obs.repeatedTasks.length > 0}
        <div class="evo-sub">重复任务（≥3 次，可考虑沉淀技能/生成工具）</div>
        <div class="evo-tasks">
          {#each obs.repeatedTasks as r}
            <span class="evo-task-chip" title={r.examples.join("\n")}>{r.pattern} ×{r.count}</span>
          {/each}
        </div>
      {/if}
    {/if}
  </div>

  <div class="evo-section">
    <div class="evo-title"><Sparkles size={14} /> 进化提案</div>
    {#if proposals.length === 0}
      <div class="evo-empty">暂无提案（点上方「运行观察并提议」生成）</div>
    {:else}
      {#each proposals as p}
        <div class="evo-proposal">
          <div class="evo-prop-head">
            <span class="evo-prop-type evo-type-{p.type}">{TYPE_LABEL[p.type] ?? p.type}</span>
            <span class="evo-prop-title">{p.title}</span>
            <span class="evo-prop-risk evo-risk-{p.risk}">风险 {RISK_LABEL[p.risk]}</span>
            <span class="evo-prop-status evo-status-{p.status}">{STATUS_LABEL[p.status]}</span>
          </div>
          <div class="evo-prop-reason">{p.reason}</div>
          <div class="evo-prop-actions">
            {#if p.status === "pending"}
              <button class="evo-btn evo-sm evo-adopt" onclick={() => act(p.id, "adopt")}><Check size={12} /> 采纳</button>
              <button class="evo-btn evo-sm evo-reject" onclick={() => act(p.id, "reject")}><X size={12} /> 拒绝</button>
            {:else}
              <span class="evo-prop-id">{p.id}</span>
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .evo-panel {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 4px 2px;
  }
  .evo-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .evo-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--panel);
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
  }
  .evo-btn:hover:not(:disabled) {
    border-color: var(--primary);
    color: var(--primary);
  }
  .evo-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .evo-ghost {
    background: transparent;
  }
  .evo-sm {
    padding: 3px 8px;
    font-size: 11px;
  }
  .evo-adopt {
    border-color: var(--success);
    color: var(--success);
  }
  .evo-reject {
    border-color: var(--error);
    color: var(--error);
  }
  .evo-msg {
    font-size: 12px;
  }
  .evo-ok {
    color: var(--success);
  }
  .evo-err {
    color: var(--error);
  }
  .evo-info {
    color: var(--warn);
  }
  .evo-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .evo-title {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }
  .evo-empty {
    color: var(--dim);
    font-size: 12px;
    padding: 12px 0;
  }
  .evo-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 8px;
  }
  .evo-card {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px;
    background: var(--panel);
  }
  .evo-card-val {
    font-size: 20px;
    font-weight: 700;
    color: var(--primary-light);
  }
  .evo-card-label {
    font-size: 11px;
    color: var(--dim);
    margin-top: 2px;
  }
  .evo-sub {
    font-size: 12px;
    color: var(--dim);
    margin-top: 4px;
  }
  .evo-tool-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .evo-tool {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }
  .evo-tool-name {
    width: 130px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }
  .evo-tool-bar {
    flex: 1;
    height: 6px;
    border-radius: 3px;
    background: var(--border);
    overflow: hidden;
  }
  .evo-tool-fill {
    display: block;
    height: 100%;
    border-radius: 3px;
  }
  .evo-tool-num {
    width: 42px;
    text-align: right;
    font-weight: 600;
  }
  .evo-tool-meta {
    width: 150px;
    color: var(--dim);
    font-size: 11px;
  }
  .evo-errors {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    padding-left: 138px;
    margin-bottom: 2px;
  }
  .evo-err-chip {
    font-size: 11px;
    color: var(--error);
    border: 1px solid color-mix(in srgb, var(--error) 40%, transparent);
    border-radius: 4px;
    padding: 1px 6px;
  }
  .evo-tasks {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .evo-task-chip {
    font-size: 11px;
    color: var(--primary-light);
    border: 1px solid color-mix(in srgb, var(--primary) 40%, transparent);
    border-radius: 4px;
    padding: 2px 8px;
    cursor: help;
  }
  .evo-proposal {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px;
    background: var(--panel);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .evo-prop-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .evo-prop-type {
    font-size: 11px;
    font-weight: 600;
    border-radius: 4px;
    padding: 1px 7px;
  }
  .evo-type-new-skill {
    background: color-mix(in srgb, var(--success) 18%, transparent);
    color: var(--success);
  }
  .evo-type-new-tool {
    background: color-mix(in srgb, var(--primary) 18%, transparent);
    color: var(--primary-light);
  }
  .evo-type-new-app {
    background: color-mix(in srgb, #a855f7 18%, transparent);
    color: #a855f7;
  }
  .evo-type-config-change {
    background: color-mix(in srgb, var(--warn) 18%, transparent);
    color: var(--warn);
  }
  .evo-type-tool-fix,
  .evo-type-prompt-fix {
    background: color-mix(in srgb, var(--dim) 18%, transparent);
    color: var(--dim);
  }
  .evo-prop-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }
  .evo-prop-risk {
    font-size: 11px;
  }
  .evo-risk-low {
    color: var(--success);
  }
  .evo-risk-medium {
    color: var(--warn);
  }
  .evo-risk-high {
    color: var(--error);
  }
  .evo-prop-status {
    font-size: 11px;
    margin-left: auto;
  }
  .evo-status-pending {
    color: var(--warn);
  }
  .evo-status-adopted {
    color: var(--success);
  }
  .evo-status-rejected {
    color: var(--dim);
  }
  .evo-prop-reason {
    font-size: 12px;
    color: var(--dim);
  }
  .evo-prop-actions {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .evo-prop-id {
    font-size: 11px;
    color: var(--dim);
  }
</style>
