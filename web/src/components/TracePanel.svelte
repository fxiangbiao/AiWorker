<script lang="ts">
  /**
   * 轨迹 Tab（Sprint 36：日志并入）
   * 上部「最近活动」= 原日志（跨会话 turn 汇总，/logs），点击条目查看该会话轨迹；
   * 下部「会话轨迹」= 原 TracePanel（/trace/<sid>），默认跟随当前会话，可手动固定目标会话
   */
  import { onMount } from "svelte";
  import { API, store } from "$lib/stores/chat.svelte";

  interface Tokens {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  }
  interface TraceItem {
    seq: number;
    type: string;
    label: string;
    detail?: string;
    full?: string;
    at: number;
    durationMs?: number;
    status?: string;
    tokens?: Tokens;
  }
  interface TraceStats {
    sessionId: string;
    turnCount: number;
    stepCount: number;
    toolCallsTotal: number;
    toolCallsFailed: number;
    tokensTotal: number;
    wallMs: number;
    finishReason: string;
    errorCount: number;
  }
  interface ActivityItem {
    id: string;
    sessionId: string;
    agentId: string;
    userInput: string;
    startedAt: number;
    iterations: number;
    toolCallsTotal: number;
    toolCallsFailed: number;
    tokensPrompt: number;
    tokensCompletion: number;
    finishReason: string;
    error?: string;
  }

  let items = $state<TraceItem[]>([]);
  let stats: TraceStats | null = $state(null);
  let loading = $state(false);
  let error = $state("");
  let selected: TraceItem | null = $state(null);

  // ── 最近活动（原日志数据）──
  let activities = $state<ActivityItem[]>([]);
  /** 手动固定的目标会话（null = 跟随当前会话） */
  let targetSession = $state<string | null>(null);
  /** 实际加载轨迹的会话 */
  let activeSession = $state<string | null>(null);

  async function loadActivities() {
    try {
      const r = await fetch(`${API}/logs`);
      if (!r.ok) return;
      const d = (await r.json()) as { logs?: ActivityItem[] };
      activities = d.logs || [];
    } catch {
      /* 服务离线静默 */
    }
  }

  // 未手动选择时跟随当前会话
  $effect(() => {
    void store.activeChatId;
    if (!targetSession) activeSession = store.activeChatId;
  });

  function pick(sid: string) {
    targetSession = sid;
    activeSession = sid;
  }
  function followCurrent() {
    targetSession = null;
    activeSession = store.activeChatId;
  }

  // 请求代际：快速切换会话/重进 Tab 时丢弃过期轨迹响应（review：防旧会话数据覆盖新会话）
  let loadSeq = 0;
  async function load() {
    const seq = ++loadSeq;
    const sid = activeSession;
    if (!sid) {
      items = [];
      stats = null;
      error = "";
      selected = null;
      return;
    }
    loading = true;
    error = "";
    try {
      const r = await fetch(`${API}/trace/${encodeURIComponent(sid)}`);
      if (seq !== loadSeq) return;
      if (!r.ok) {
        items = [];
        stats = null;
        error = "该会话暂无轨迹";
        return;
      }
      const d = await r.json();
      if (seq !== loadSeq) return;
      items = d.items || [];
      stats = d.stats || null;
      selected = null;
    } catch {
      if (seq !== loadSeq) return;
      items = [];
      stats = null;
      error = "加载失败";
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }

  $effect(() => {
    void activeSession;
    load();
  });

  onMount(() => {
    void loadActivities();
  });

  const typeLabel: Record<string, string> = {
    turn: "轮次",
    step: "步",
    user: "用户",
    assistant: "助手",
    tool: "工具",
    memory: "记忆",
    title: "标题",
  };
  const typeCls: Record<string, string> = {
    turn: "t-turn",
    step: "t-step",
    user: "t-user",
    assistant: "t-assistant",
    tool: "t-tool",
    memory: "t-memory",
    title: "t-title",
  };

  function fmtDur(ms?: number): string {
    if (ms === undefined) return "";
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  }
  function fmtTok(t?: number): string {
    if (!t) return "-";
    return t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);
  }
  function fmtTime(ts: number): string {
    const d = new Date(ts);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }

  function selectItem(it: TraceItem) {
    selected = it;
  }

  // 活动分组（今天/昨天/日期）
  function dayKey(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }
  function dayLabel(ts: number): string {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (dayKey(ts) === dayKey(today.getTime())) return "今天";
    if (dayKey(ts) === dayKey(yesterday.getTime())) return "昨天";
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  const activityGroups = $derived.by(() => {
    const map = new Map<string, ActivityItem[]>();
    for (const a of [...activities].sort((x, y) => (y.startedAt || 0) - (x.startedAt || 0))) {
      const k = dayLabel(a.startedAt || 0);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(a);
    }
    return [...map.entries()];
  });
</script>

<div class="tp-body">
  <!-- 最近活动（原日志并入） -->
  <div class="tp-act">
    <div class="tp-act-head">
      <span class="tp-act-title">最近活动</span>
      {#if targetSession}
        <button class="tp-act-follow" onclick={followCurrent}>跟随当前会话</button>
      {/if}
    </div>
    {#if activities.length === 0}
      <div class="tp-act-empty">暂无活动记录（对话/任务执行后出现）</div>
    {:else}
      {#each activityGroups as [label, items] (label)}
        <div class="tp-act-group">{label}</div>
        {#each items as a (a.id)}
          <div
            class="tp-act-item"
            class:active={activeSession === a.sessionId}
            onclick={() => pick(a.sessionId)}
            role="button"
            tabindex="0"
            onkeydown={(e) => e.key === "Enter" && pick(a.sessionId)}
          >
            <span class="tp-act-input">{a.userInput || "(无输入)"}</span>
            <span
              class="tp-act-meta"
              title="token 为轮次差分（含同轮压缩请求；不含 loop 外摘要）"
            >
              {a.agentId} · {a.iterations} 轮 · {a.toolCallsTotal} 工具
              {#if (a.toolCallsFailed ?? 0) > 0}<span class="tp-bad">失败 {a.toolCallsFailed}</span>{/if}
              · {fmtTok((a.tokensPrompt ?? 0) + (a.tokensCompletion ?? 0))} tok
            </span>
          </div>
        {/each}
      {/each}
    {/if}
  </div>

  <!-- 会话轨迹 -->
  <div class="tp-trace">
    {#if !activeSession}
      <div class="tp-empty">选择一个会话后查看轨迹</div>
    {:else if loading}
      <div class="tp-empty">加载中...</div>
    {:else if error}
      <div class="tp-empty">{error}</div>
    {:else}
      {#if stats}
        <div class="tp-stats">
          <span class="tp-stat"><b>{stats.turnCount}</b> 轮</span>
          <span class="tp-stat"><b>{stats.stepCount}</b> 步</span>
          <span class="tp-stat">
            <b>{stats.toolCallsTotal}</b> 工具
            {#if (stats.toolCallsFailed ?? 0) > 0}<span class="tp-bad">失败 {stats.toolCallsFailed}</span>{/if}
          </span>
          <span class="tp-stat" title="会话累计 token（事件求和，不含摘要/压缩请求）"><b>{fmtTok(stats.tokensTotal)}</b> tok</span>
          <span class="tp-stat"><b>{fmtDur(stats.wallMs)}</b></span>
          {#if (stats.errorCount ?? 0) > 0}
            <span class="tp-stat tp-bad">⚠ {stats.errorCount} 错误</span>
          {/if}
        </div>
      {/if}
      {#if items.length === 0}
        <div class="tp-empty">暂无轨迹</div>
      {:else}
        <div class="tp-layout">
          <div class="tp-left">
            {#each items as it (it.seq)}
              <div
                class="tp-item {typeCls[it.type] || ''}"
                class:fail={it.status === "fail"}
                class:active={selected?.seq === it.seq}
                onclick={() => selectItem(it)}
                role="button"
                tabindex="0"
                onkeydown={(e) => (e.key === "Enter" || e.key === " ") && selectItem(it)}
              >
                <span class="tp-time">{fmtTime(it.at)}</span>
                <span class="tp-label">
                  {it.type === "tool" ? `🔧 ${it.label}` : (typeLabel[it.type] || it.type)}
                  {it.durationMs !== undefined ? ` · ${fmtDur(it.durationMs)}` : ""}
                  {it.status === "running" ? " · …" : ""}
                </span>
                {#if it.detail}<span class="tp-detail">{it.detail}</span>{/if}
              </div>
            {/each}
          </div>
          <div class="tp-right">
            {#if selected}
              <div class="tpr-head">
                <span class="tpr-title">
                  {selected.type === "tool" ? `🔧 ${selected.label}` : (typeLabel[selected.type] || selected.type)}
                  <span class:fail={selected.status === "fail"} class:ok={selected.status === "ok"}>
                    {selected.status === "fail" ? "失败" : selected.status === "ok" ? "成功" : "进行中"}
                  </span>
                </span>
                <span class="tpr-meta">
                  {fmtTime(selected.at)}
                  {#if selected.durationMs !== undefined} · {fmtDur(selected.durationMs)}{/if}
                  {#if selected.tokens && selected.tokens.totalTokens} · {fmtTok(selected.tokens.totalTokens)} tok{/if}
                </span>
              </div>
              <div class="tpr-content">{selected.full ?? selected.detail ?? "（无详细内容）"}</div>
            {:else}
              <div class="tpr-empty">← 点击左侧轨迹项查看详情</div>
            {/if}
          </div>
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .tp-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 160px;
    height: 100%;
  }
  .tp-empty {
    color: var(--text-dim, #8a8f98);
    font-size: 12px;
    text-align: center;
    padding: 24px 0;
  }
  /* ── 最近活动（原日志）── */
  .tp-act {
    flex-shrink: 0;
    max-height: 150px;
    overflow-y: auto;
    border: 1px solid var(--border, #e2e4e8);
    border-radius: 8px;
    padding: 6px 8px;
    background: var(--bg-soft, #f6f7f9);
  }
  .tp-act-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }
  .tp-act-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-dim, #8a8f98);
    text-transform: uppercase;
    letter-spacing: .5px;
  }
  .tp-act-follow {
    font-size: 11px;
    color: var(--accent, #4c6fff);
    background: transparent;
    border: 1px solid var(--border, #e2e4e8);
    border-radius: 10px;
    padding: 1px 8px;
    cursor: pointer;
  }
  .tp-act-follow:hover { border-color: var(--accent, #4c6fff); }
  .tp-act-group {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-dim, #8a8f98);
    padding: 4px 2px 2px;
  }
  .tp-act-item {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 10px;
    font-size: 11px;
    padding: 3px 6px;
    border-radius: 5px;
    cursor: pointer;
  }
  .tp-act-item:hover { background: var(--bg, #fff); }
  .tp-act-item.active { background: var(--bg, #fff); outline: 1px solid var(--accent, #4c6fff); }
  .tp-act-input {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
    font-weight: 500;
  }
  .tp-act-meta { color: var(--text-dim, #8a8f98); flex-shrink: 0; }
  .tp-act-empty { font-size: 11px; color: var(--text-dim, #8a8f98); padding: 6px 2px; }
  /* ── 轨迹 ── */
  .tp-trace {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .tp-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    padding: 8px 10px;
    background: var(--bg-soft, #f2f3f5);
    border-radius: 8px;
    font-size: 12px;
    flex-shrink: 0;
  }
  .tp-stat b {
    font-weight: 600;
  }
  .tp-bad {
    color: #e5484d;
  }
  .tp-layout {
    display: flex;
    gap: 12px;
    flex: 1;
    min-height: 0;
  }
  .tp-left {
    width: 320px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow-y: auto;
    border-right: 1px solid var(--border, #e2e4e8);
    padding-right: 8px;
  }
  .tp-item {
    display: flex;
    gap: 8px;
    align-items: baseline;
    font-size: 12px;
    padding: 4px 6px;
    border-radius: 6px;
    cursor: pointer;
  }
  .tp-item:hover {
    background: var(--bg-soft, #f2f3f5);
  }
  .tp-item.active {
    background: var(--bg-soft, #f2f3f5);
    outline: 1px solid var(--accent, #4c6fff);
  }
  .tp-item.fail {
    color: #e5484d;
  }
  .tp-time {
    color: var(--text-dim, #8a8f98);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
    font-size: 11px;
  }
  .tp-label {
    font-weight: 500;
    flex-shrink: 0;
    white-space: nowrap;
  }
  .t-turn .tp-label {
    color: var(--accent, #4c6fff);
  }
  .t-user .tp-label {
    color: #22a06b;
  }
  .t-assistant .tp-label {
    color: #4c6fff;
  }
  .t-tool .tp-label {
    color: #d97706;
  }
  .tp-detail {
    color: var(--text-dim, #8a8f98);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
    font-size: 11px;
  }
  .tp-right {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow-y: auto;
  }
  .tpr-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border, #e2e4e8);
    padding-bottom: 6px;
  }
  .tpr-title {
    font-size: 13px;
    font-weight: 600;
  }
  .tpr-title .ok {
    color: #22a06b;
    font-size: 11px;
    font-weight: 500;
    margin-left: 6px;
  }
  .tpr-title .fail {
    color: #e5484d;
    font-size: 11px;
    font-weight: 500;
    margin-left: 6px;
  }
  .tpr-meta {
    color: var(--text-dim, #8a8f98);
    font-size: 11px;
    flex-shrink: 0;
  }
  .tpr-content {
    font-size: 12px;
    line-height: 1.7;
    color: var(--text, #1a1d21);
    white-space: pre-wrap;
    word-break: break-word;
    flex: 1;
  }
  .tpr-empty {
    color: var(--text-dim, #8a8f98);
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
  }
</style>
