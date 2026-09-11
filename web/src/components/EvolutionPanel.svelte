<script lang="ts">
  /**
   * 进化引擎面板（Sprint 39 第一期）
   * 观察指标仪表 + 提案列表（采纳/拒绝）+ 运行观察并提议
   */
  import { onMount } from "svelte";
  import { API } from "$lib/stores/chat.svelte";
  import { onWsEvent } from "$lib/stores/ws.svelte";
  import { Sparkles, RefreshCw, Check, X, BrainCircuit, FileDiff, FlaskConical, ShieldCheck, Plus, Trash2, Database } from "lucide-svelte";

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
    action: {
      kind: string;
      expert?: string;
      body?: string;
      description?: string;
      field?: string;
      value?: unknown;
      toolName?: string;
      suggestion?: string;
      agentId?: string;
      newDescription?: string;
      newPrompt?: string;
    };
    risk: "low" | "medium" | "high";
    status: "pending" | "confirmed" | "applied" | "rejected" | "rolled_back";
    createdAt: number;
  }

  interface LedgerEntry {
    at?: number;
    event?: string;
    id?: string;
    type?: string;
    title?: string;
    detail?: string;
    jobId?: string;
  }

  interface EvalCaseResult {
    caseId: string;
    beforeOk: boolean;
    afterOk: boolean;
    reason?: string;
  }
  interface EvalReport {
    total: number;
    skipped: number;
    hasBaseline: boolean;
    baselinePassRate: number;
    candidatePassRate: number;
    deltaRate: number;
    beforeLatencyMs?: number;
    afterLatencyMs?: number;
    verdict: "pass" | "regress" | "unknown" | "not-evaluable";
    reason?: string;
    results: EvalCaseResult[];
  }
  interface EvolutionCase {
    id: string;
    input: string;
    expected?: string;
    source: "manual" | "session";
    sessionId?: string;
    createdAt: number;
  }

  let obs = $state<Observation | null>(null);
  let proposals = $state<Proposal[]>([]);
  let ledger = $state<LedgerEntry[]>([]);
  let changes = $state<Record<string, ChangeView>>({});
  let reports = $state<Record<string, EvalReport>>({});
  let cases = $state<EvolutionCase[]>([]);
  let newCaseInput = $state("");
  let newCaseExpected = $state("");
  let caseBusy = $state(false);
  let loading = $state(false);
  let busy = $state(false);
  let msg = $state<{ kind: "ok" | "err" | "info"; text: string } | null>(null);

  interface DiffLine {
    type: "same" | "add" | "del";
    text: string;
  }
  interface ChangeView {
    proposalId: string;
    kind: string;
    title: string;
    before?: string;
    after: string;
    lines: DiffLine[];
  }

  const TYPE_LABEL: Record<string, string> = {
    "new-skill": "新技能",
    "new-tool": "新工具",
    "new-app": "新应用",
    "config-change": "配置变更",
    "tool-fix": "工具修复",
    "prompt-fix": "提示词修复",
  };
  const RISK_LABEL: Record<string, string> = { low: "低", medium: "中", high: "高" };
  const STATUS_LABEL: Record<string, string> = { pending: "待确认", confirmed: "已确认·待写入", applied: "已写入", rejected: "已拒绝", rolled_back: "已回滚" };
  const EVENT_LABEL: Record<string, string> = {
    proposed: "提议",
    confirmed: "确认",
    applied: "写入",
    rolled_back: "回滚",
    rejected: "拒绝",
    "generated-submitted": "生成提交",
    generated: "生成结果",
    eval: "评测",
    verified: "验证",
  };

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

  async function loadLedger() {
    try {
      const r = await fetch(`${API}/evolution/ledger?limit=20`);
      if (r.ok) ledger = ((await r.json()) as { entries: LedgerEntry[] }).entries ?? [];
    } catch {
      /* 静默 */
    }
  }

  async function loadCases() {
    try {
      const r = await fetch(`${API}/evolution/cases?limit=50`);
      if (r.ok) cases = ((await r.json()) as { cases: EvolutionCase[] }).cases ?? [];
    } catch {
      /* 静默 */
    }
  }

  /** A/B 评测（不动作）：pending/confirmed/applied 均可；报告仅当次展示（重跑即刷新） */
  async function runEval(id: string) {
    msg = null;
    try {
      const r = await fetch(`${API}/evolution/proposals/${id}/eval`, { method: "POST" });
      const d = (await r.json()) as { ok: boolean; report?: EvalReport; error?: string };
      if (!r.ok || !d.ok) {
        msg = { kind: "err", text: d.error ?? `评测失败（HTTP ${r.status}）` };
        return;
      }
      reports = { ...reports, [id]: d.report! };
      await loadLedger();
    } catch (e) {
      msg = { kind: "err", text: (e as Error).message };
    }
  }

  /** 推广后验证（仅 applied）：回归自动回滚 */
  async function runVerify(id: string) {
    msg = null;
    try {
      const r = await fetch(`${API}/evolution/proposals/${id}/verify`, { method: "POST" });
      const d = (await r.json()) as { ok: boolean; report?: EvalReport; rolledBack?: boolean; detail?: string; error?: string };
      if (!r.ok || !d.ok) {
        msg = { kind: "err", text: d.error ?? `验证失败（HTTP ${r.status}）` };
        return;
      }
      if (d.report) reports = { ...reports, [id]: d.report };
      msg = d.rolledBack
        ? { kind: "info", text: `评测回归，已自动回滚${d.detail ? ` · ${d.detail}` : ""}` }
        : { kind: "ok", text: `验证完成（${d.report?.verdict ?? ""}），未触发回滚` };
      await loadProposals();
      await loadLedger();
    } catch (e) {
      msg = { kind: "err", text: (e as Error).message };
    }
  }

  async function addCase() {
    const input = newCaseInput.trim();
    if (!input) return;
    caseBusy = true;
    try {
      const r = await fetch(`${API}/evolution/cases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, expected: newCaseExpected.trim() || undefined }),
      });
      const d = (await r.json()) as { ok: boolean; error?: string };
      if (!r.ok || !d.ok) {
        msg = { kind: "err", text: d.error ?? `补录失败（HTTP ${r.status}）` };
      } else {
        newCaseInput = "";
        newCaseExpected = "";
        msg = { kind: "ok", text: "已补录黄金用例" };
      }
      await loadCases();
    } catch (e) {
      msg = { kind: "err", text: (e as Error).message };
    } finally {
      caseBusy = false;
    }
  }

  async function extractCases() {
    caseBusy = true;
    try {
      const r = await fetch(`${API}/evolution/cases/extract`, { method: "POST" });
      const d = (await r.json()) as { added: number; skipped: number };
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      msg = { kind: "ok", text: `提取完成: 新增 ${d.added} · 去重跳过 ${d.skipped}` };
      await loadCases();
    } catch (e) {
      msg = { kind: "err", text: (e as Error).message };
    } finally {
      caseBusy = false;
    }
  }

  async function deleteCase(id: string) {
    try {
      const r = await fetch(`${API}/evolution/cases/${id}`, { method: "DELETE" });
      if (r.ok) await loadCases();
    } catch {
      /* 静默 */
    }
  }

  function verdictBadge(v: string): string {
    return v === "pass" ? "✅ 通过" : v === "regress" ? "🔻 回归" : v === "unknown" ? "⚠️ 未知" : "⛔ 不可评测";
  }

  /** 加载/切换提案变更对比（已缓存则收起；未缓存则加载并展开） */
  async function toggleChange(id: string) {
    if (changes[id]) {
      const next = { ...changes };
      delete next[id];
      changes = next;
      return;
    }
    try {
      const r = await fetch(`${API}/evolution/proposals/${id}/change`);
      if (r.ok) {
        const d = (await r.json()) as { ok: boolean; view?: ChangeView; error?: string };
        if (d.ok && d.view) changes = { ...changes, [id]: d.view };
        else if (d.error) msg = { kind: "err", text: d.error };
      } else {
        msg = { kind: "err", text: `变更加载失败（HTTP ${r.status}）` };
      }
    } catch {
      msg = { kind: "err", text: "变更加载失败（网络错误）" };
    }
  }

  async function act(id: string, action: "adopt" | "apply" | "rollback" | "reject") {
    msg = null;
    try {
      const r = await fetch(`${API}/evolution/proposals/${id}/${action}`, { method: "POST" });
      const d = (await r.json()) as { ok: boolean; jobId?: string; detail?: string; error?: string; preview?: unknown };
      if (!r.ok || !d.ok) {
        msg = { kind: "err", text: d.error ?? `操作失败（HTTP ${r.status}）` };
      } else if (action === "adopt") {
        msg = { kind: "ok", text: "已确认提案（尚未写入），请审查下方内容后点「确认写入」" };
      } else if (action === "apply") {
        msg = {
          kind: "ok",
          text: `已写入${d.jobId ? `，生成任务 ${d.jobId}（进度见右侧「应用」Tab）` : ""}${d.detail ? ` · ${d.detail}` : ""}`,
        };
        // apply 后快照出现，清缓存使「查看变更」刷新为 before/after 对照
        if (changes[id]) {
          const next = { ...changes };
          delete next[id];
          changes = next;
        }
      } else if (action === "rollback") {
        msg = { kind: "ok", text: `已回滚${d.detail ? ` · ${d.detail}` : ""}` };
      } else {
        msg = { kind: "ok", text: "已拒绝" };
      }
      await loadProposals();
      await loadLedger();
    } catch (e) {
      msg = { kind: "err", text: (e as Error).message };
    }
  }

  /** 渲染确认态预览文本（action 内容，供用户审查） */
  function previewText(p: Proposal): string {
    const a = p.action;
    switch (a.kind) {
      case "new-skill":
        return `专家: ${a.expert}\n\n${a.body ?? ""}`;
      case "new-tool":
        return `生成工具: ${a.description ?? ""}`;
      case "new-app":
        return `生成应用: ${a.description ?? ""}`;
      case "config-change":
        return `配置项: ${a.field} = ${JSON.stringify(a.value)}`;
      case "tool-fix":
        return `工具: ${a.toolName}\n建议: ${a.suggestion}\n新描述: ${a.newDescription ?? ""}`;
      case "prompt-fix":
        return `智能体: ${a.agentId}\n建议: ${a.suggestion}\n新提示词:\n${a.newPrompt ?? ""}`;
      default:
        return "";
    }
  }

  function fmtAt(at?: number): string {
    if (!at) return "-";
    const d = new Date(at);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  let unsubWs: (() => void) | null = null;

  onMount(() => {
    loadObserve();
    loadProposals();
    loadLedger();
    loadCases();
    unsubWs = onWsEvent((d) => {
      const t = (d as { type?: string }).type ?? "";
      if (t.startsWith("evolution/") || t === "gen/done" || t === "gen/failed") {
        loadProposals();
        loadObserve();
        loadLedger();
        loadCases();
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
          {#if p.status === "confirmed"}
            <div class="evo-preview">
              <div class="evo-preview-title">将写入的内容（确认无误后点「确认写入」）：</div>
              <pre class="evo-preview-body">{previewText(p)}</pre>
            </div>
          {/if}
          {#if changes[p.id]}
            <div class="evo-diff">
              <div class="evo-diff-title">变更对比（{changes[p.id].before === undefined ? "纯新增" : "修改"}）：</div>
              {#if changes[p.id].before !== undefined}
                <div class="evo-diff-cols">
                  <div class="evo-diff-col">
                    <div class="evo-diff-col-title">修改前</div>
                    <pre class="evo-diff-before">{changes[p.id].before}</pre>
                  </div>
                  <div class="evo-diff-col">
                    <div class="evo-diff-col-title">修改后</div>
                    <pre class="evo-diff-after">{changes[p.id].after}</pre>
                  </div>
                </div>
              {/if}
              <div class="evo-diff-lines">
                {#each changes[p.id].lines as line}
                  {#if line.type !== "same"}
                    <div class="evo-diff-line evo-diff-{line.type}"><span class="evo-diff-mark">{line.type === "add" ? "+" : "−"}</span>{line.text || "␣"}</div>
                  {/if}
                {/each}
              </div>
            </div>
          {/if}
          {#if reports[p.id]}
            <div class="evo-diff">
              <div class="evo-diff-title">评测报告（A/B · {verdictBadge(reports[p.id].verdict)}）</div>
              {#if reports[p.id].verdict === "not-evaluable"}
                <div class="evo-empty">{reports[p.id].reason}</div>
              {:else}
                <div class="evo-eval-rate">
                  {#if reports[p.id].hasBaseline}
                    <span>旧 {pct(reports[p.id].baselinePassRate)}</span>
                    <span class="evo-eval-bar"><span class="evo-eval-fill" style="width:{Math.max(2, reports[p.id].baselinePassRate * 100)}%;background:var(--dim)"></span></span>
                    <span>→ 新 {pct(reports[p.id].candidatePassRate)}</span>
                    <span class="evo-eval-bar"><span class="evo-eval-fill" style="width:{Math.max(2, reports[p.id].candidatePassRate * 100)}%;background:{reports[p.id].verdict === "regress" ? "var(--error)" : "var(--success)"}"></span></span>
                  {:else}
                    <span>候选成功率 {pct(reports[p.id].candidatePassRate)}（无基线）</span>
                  {/if}
                  <span class="evo-eval-meta">计分 {reports[p.id].total} · 跳过 {reports[p.id].skipped}</span>
                </div>
                <div class="evo-diff-lines">
                  {#each reports[p.id].results as res}
                    <div class="evo-diff-line">
                      <span class="evo-diff-mark">{res.afterOk === res.beforeOk ? "·" : res.afterOk ? "↑" : "↓"}</span>
                      {res.caseId}{reports[p.id].hasBaseline ? ` 旧:${res.beforeOk ? "✓" : "✗"}` : ""} 新:{res.afterOk ? "✓" : "✗"}{res.reason ? ` ${res.reason}` : ""}
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
          <div class="evo-prop-actions">
            {#if p.status === "pending" || p.status === "confirmed" || p.status === "applied"}
              <button class="evo-btn evo-sm evo-ghost" onclick={() => runEval(p.id)}><FlaskConical size={12} /> 评测</button>
            {/if}
            {#if p.status === "pending"}
              <button class="evo-btn evo-sm evo-adopt" onclick={() => act(p.id, "adopt")}><Check size={12} /> 采纳</button>
              <button class="evo-btn evo-sm evo-reject" onclick={() => act(p.id, "reject")}><X size={12} /> 拒绝</button>
            {:else if p.status === "confirmed"}
              <button class="evo-btn evo-sm evo-adopt" onclick={() => act(p.id, "apply")}><Check size={12} /> 确认写入</button>
              <button class="evo-btn evo-sm evo-reject" onclick={() => act(p.id, "reject")}><X size={12} /> 撤销</button>
            {:else if p.status === "applied" || p.status === "rolled_back"}
              <button class="evo-btn evo-sm evo-ghost" onclick={() => toggleChange(p.id)}><FileDiff size={12} /> {changes[p.id] ? "收起变更" : "查看变更"}</button>
              {#if p.status === "applied"}
                <button class="evo-btn evo-sm evo-adopt" onclick={() => runVerify(p.id)}><ShieldCheck size={12} /> 推广验证</button>
                <button class="evo-btn evo-sm evo-rollback" onclick={() => act(p.id, "rollback")}><RefreshCw size={12} /> 回滚</button>
              {/if}
              <span class="evo-prop-id">{p.id}</span>
            {:else}
              <span class="evo-prop-id">{p.id}</span>
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </div>

  <div class="evo-section">
    <div class="evo-title"><Database size={14} /> 黄金用例（{cases.length}，评测集）</div>
    <div class="evo-case-toolbar">
      <input class="evo-case-input" placeholder="任务描述（手工补录）" bind:value={newCaseInput} />
      <input class="evo-case-input evo-case-expected" placeholder="期望达成（可选）" bind:value={newCaseExpected} />
      <button class="evo-btn evo-sm" onclick={addCase} disabled={caseBusy || !newCaseInput.trim()}><Plus size={12} /> 补录</button>
      <button class="evo-btn evo-sm evo-ghost" onclick={extractCases} disabled={caseBusy}><Sparkles size={12} /> 从会话提取</button>
    </div>
    {#if cases.length === 0}
      <div class="evo-empty">暂无黄金用例（评测前先「从会话提取」或手工补录）</div>
    {:else}
      <div class="evo-case-list">
        {#each cases as c}
          <div class="evo-case-row">
            <span class="evo-case-src">{c.source === "session" ? "📜" : "✍️"}</span>
            <span class="evo-case-input-text" title={c.input}>{c.input}</span>
            {#if c.expected}
              <span class="evo-case-exp" title={c.expected}>期望</span>
            {/if}
            <button class="evo-btn evo-sm evo-ghost" onclick={() => deleteCase(c.id)}><Trash2 size={11} /></button>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <div class="evo-section">
    <div class="evo-title"><RefreshCw size={14} /> 进化台账（最近 {ledger.length} 条）</div>
    {#if ledger.length === 0}
      <div class="evo-empty">暂无台账记录</div>
    {:else}
      <div class="evo-ledger">
        {#each ledger as e}
          <div class="evo-ledger-row">
            <span class="evo-ledger-at">{fmtAt(e.at)}</span>
            <span class="evo-ledger-event">{EVENT_LABEL[e.event ?? ""] ?? e.event}</span>
            <span class="evo-ledger-title">{e.title ?? e.id ?? ""}</span>
            {#if e.jobId}
              <span class="evo-ledger-job">{e.jobId}</span>
            {/if}
          </div>
        {/each}
      </div>
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
  .evo-rollback {
    border-color: var(--warn);
    color: var(--warn);
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
    color: var(--primary);
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
    color: var(--primary);
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
    color: var(--primary);
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
  .evo-status-confirmed {
    color: var(--primary);
  }
  .evo-status-applied {
    color: var(--success);
  }
  .evo-status-rolled_back {
    color: var(--dim);
    text-decoration: line-through;
  }
  .evo-status-rejected {
    color: var(--dim);
  }
  .evo-prop-reason {
    font-size: 12px;
    color: var(--dim);
  }
  .evo-preview {
    border: 1px solid color-mix(in srgb, var(--primary) 35%, transparent);
    border-radius: 6px;
    padding: 8px;
    background: color-mix(in srgb, var(--primary) 6%, transparent);
  }
  .evo-preview-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--primary);
    margin-bottom: 4px;
  }
  .evo-preview-body {
    font-size: 11px;
    line-height: 1.5;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
    max-height: 180px;
    overflow: auto;
  }
  .evo-diff {
    border: 1px solid color-mix(in srgb, var(--primary) 35%, transparent);
    border-radius: 6px;
    padding: 8px;
    background: color-mix(in srgb, var(--primary) 6%, transparent);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .evo-diff-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--primary);
  }
  .evo-diff-cols {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .evo-diff-col-title {
    font-size: 11px;
    color: var(--dim);
    margin-bottom: 2px;
  }
  .evo-diff-before,
  .evo-diff-after {
    font-size: 11px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
    max-height: 120px;
    overflow: auto;
    border-radius: 4px;
    padding: 6px;
  }
  .evo-diff-before {
    background: color-mix(in srgb, var(--error) 8%, transparent);
    color: var(--text);
  }
  .evo-diff-after {
    background: color-mix(in srgb, var(--success) 8%, transparent);
    color: var(--text);
  }
  .evo-diff-lines {
    display: flex;
    flex-direction: column;
    max-height: 160px;
    overflow: auto;
    font-size: 11px;
    line-height: 1.5;
  }
  .evo-diff-line {
    padding: 0 4px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .evo-diff-add {
    background: color-mix(in srgb, var(--success) 14%, transparent);
    color: var(--success);
  }
  .evo-diff-del {
    background: color-mix(in srgb, var(--error) 14%, transparent);
    color: var(--error);
    text-decoration: line-through;
  }
  .evo-diff-mark {
    display: inline-block;
    width: 14px;
    font-weight: 700;
  }
  .evo-eval-rate {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text);
    flex-wrap: wrap;
  }
  .evo-eval-bar {
    width: 90px;
    height: 6px;
    border-radius: 3px;
    background: var(--border);
    overflow: hidden;
  }
  .evo-eval-fill {
    display: block;
    height: 100%;
    border-radius: 3px;
  }
  .evo-eval-meta {
    color: var(--dim);
    font-size: 11px;
  }
  .evo-case-toolbar {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .evo-case-input {
    flex: 1;
    min-width: 140px;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    color: var(--text);
    font-size: 12px;
  }
  .evo-case-expected {
    flex: 0.7;
  }
  .evo-case-list {
    display: flex;
    flex-direction: column;
    gap: 3px;
    max-height: 180px;
    overflow: auto;
  }
  .evo-case-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    padding: 3px 6px;
    border-radius: 4px;
  }
  .evo-case-row:hover {
    background: var(--hover-bg);
  }
  .evo-case-src {
    flex-shrink: 0;
  }
  .evo-case-input-text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }
  .evo-case-exp {
    flex-shrink: 0;
    font-size: 10px;
    color: var(--primary);
    border: 1px solid color-mix(in srgb, var(--primary) 40%, transparent);
    border-radius: 4px;
    padding: 0 5px;
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
  .evo-ledger {
    display: flex;
    flex-direction: column;
    gap: 3px;
    max-height: 200px;
    overflow: auto;
  }
  .evo-ledger-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    padding: 3px 6px;
    border-radius: 4px;
  }
  .evo-ledger-row:hover {
    background: var(--hover-bg);
  }
  .evo-ledger-at {
    color: var(--dim);
    width: 72px;
    flex-shrink: 0;
  }
  .evo-ledger-event {
    color: var(--primary);
    width: 60px;
    flex-shrink: 0;
    font-weight: 600;
  }
  .evo-ledger-title {
    color: var(--text);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .evo-ledger-job {
    color: var(--dim);
    font-size: 10px;
  }
</style>
