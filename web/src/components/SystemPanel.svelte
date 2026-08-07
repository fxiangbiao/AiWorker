<script lang="ts">
  import { onMount } from "svelte";
  import { API } from "$lib/stores/chat.svelte";

  let tab = $state<"context" | "logs" | "skills">("context");
  let breakdown: {
    systemPromptBase?: number;
    projectMemory?: number;
    userProfile?: number;
    episodicMemory?: number;
    injectedSkills?: number;
    conversationHistory?: number;
    currentTurn?: number;
    total?: number;
    skillsMatched?: string[];
    skillsTotal?: number;
  } = $state({});
  let logs: {
    id?: string;
    userInput?: string;
    agentId?: string;
    iterations?: number;
    toolCallsTotal?: number;
    toolCallsFailed?: number;
    tokensPrompt?: number;
    tokensCompletion?: number;
    finishReason?: string;
  }[] = $state([]);
  let skillList = $state<{ name: string; description: string; expert: string }[]>([]);
  let loading = $state(false);

  let groups = $derived.by(() => {
    const byExpert = new Map<string, { name: string; description: string; expert: string }[]>();
    for (const s of skillList) {
      const key = s.expert || "general";
      const list = byExpert.get(key) ?? [];
      list.push(s);
      byExpert.set(key, list);
    }
    return Array.from(byExpert.entries());
  });

  function fmtTok(t?: number): string {
    if (t === undefined) return "-";
    if (t >= 1000) return `${(t / 1000).toFixed(1)}k`;
    return String(t);
  }

  function loadContext() {
    loading = true;
    fetch(`${API}/context`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { breakdown = d.breakdown || {}; })
      .catch(() => { breakdown = {}; })
      .finally(() => { loading = false; });
  }

  function loadLogs() {
    loading = true;
    fetch(`${API}/logs`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { logs = d.logs || []; })
      .catch(() => { logs = []; })
      .finally(() => { loading = false; });
  }

  function loadSkills() {
    loading = true;
    fetch(`${API}/skills`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        const raw = (d.skills || []) as unknown[];
        skillList = raw.map((s) => {
          if (typeof s === "string") return { name: s, description: "", expert: "" };
          const o = s as { name?: string; description?: string; expert?: string };
          return { name: o.name ?? "", description: o.description ?? "", expert: o.expert ?? "" };
        });
      })
      .catch(() => { skillList = []; })
      .finally(() => { loading = false; });
  }

  function switchTab(t: "context" | "logs" | "skills") {
    tab = t;
    if (t === "context") loadContext();
    else if (t === "logs") loadLogs();
    else loadSkills();
  }

  onMount(() => loadContext());
</script>

<div class="sys-panel">
  <div class="sp-tabs">
    <button class="sp-tab" class:active={tab === "context"} onclick={() => switchTab("context")}>上下文</button>
    <button class="sp-tab" class:active={tab === "logs"} onclick={() => switchTab("logs")}>日志</button>
    <button class="sp-tab" class:active={tab === "skills"} onclick={() => switchTab("skills")}>技能</button>
  </div>

  {#if loading}
    <div class="sp-empty">加载中...</div>
  {:else if tab === "context"}
    <div class="sp-section">
      <div class="sp-row"><span>系统提示</span><b>{fmtTok(breakdown.systemPromptBase)}</b></div>
      <div class="sp-row"><span>项目记忆</span><b>{fmtTok(breakdown.projectMemory)}</b></div>
      <div class="sp-row"><span>用户画像</span><b>{fmtTok(breakdown.userProfile)}</b></div>
      <div class="sp-row"><span>情景记忆</span><b>{fmtTok(breakdown.episodicMemory)}</b></div>
      <div class="sp-row"><span>注入技能</span><b>{fmtTok(breakdown.injectedSkills)}</b></div>
      <div class="sp-row"><span>会话历史</span><b>{fmtTok(breakdown.conversationHistory)}</b></div>
      <div class="sp-row"><span>当前消息</span><b>{fmtTok(breakdown.currentTurn)}</b></div>
      <div class="sp-row sp-total"><span>总计</span><b>{fmtTok(breakdown.total)}</b></div>
      <div class="sp-note">技能 {breakdown.skillsMatched?.length ?? 0}/{breakdown.skillsTotal ?? 0} 匹配</div>
    </div>
  {:else if tab === "logs"}
    {#if logs.length === 0}
      <div class="sp-empty">暂无日志</div>
    {:else}
      <div class="sp-log-list">
        {#each logs as l}
          <div class="sp-log">
            <div class="sp-log-title">{(l.userInput || "").slice(0, 32) || "—"}</div>
            <div class="sp-log-meta">
              {l.agentId || "-"} · 迭代 {l.iterations ?? 0} · 工具 {l.toolCallsTotal ?? 0}
            </div>
            <div class="sp-log-meta">
              输入 {fmtTok(l.tokensPrompt)} · 输出 {fmtTok(l.tokensCompletion)}
              · <span class:ok={!l.toolCallsFailed} class:bad={(l.toolCallsFailed ?? 0) > 0}>
                  {(l.toolCallsFailed ?? 0) > 0 ? `失败 ${l.toolCallsFailed}` : "成功"}
                </span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {:else}
    {#if skillList.length === 0}
      <div class="sp-empty">暂无技能</div>
    {:else}
      <div class="sp-groups">
        {#each groups as [expert, skills]}
          <div class="sp-group">
            <div class="sp-group-title">{expert || "general"}</div>
            {#each skills as s}
              <div class="sp-skill" title={s.description}>
                <div class="sp-skill-name">&#9670; {s.name}</div>
                {#if s.description}
                  <div class="sp-skill-desc">{s.description}</div>
                {/if}
              </div>
            {/each}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .sys-panel { display: flex; flex-direction: column; gap: 10px; }
  .sp-tabs { display: flex; gap: 4px; }
  .sp-tab {
    flex: 1;
    padding: 6px 4px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--dim);
    font-family: var(--font-ui);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }
  .sp-tab.active { color: var(--primary); border-bottom-color: var(--primary); }
  .sp-section { display: flex; flex-direction: column; gap: 6px; }
  .sp-row {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: var(--dim);
    padding: 4px 0;
    border-bottom: 1px dashed var(--border);
  }
  .sp-row b { color: var(--text); font-weight: 600; }
  .sp-total b { color: var(--primary); }
  .sp-note { font-size: 11px; color: var(--dim); margin-top: 6px; }
  .sp-empty { font-size: 12px; color: var(--dim); padding: 12px 0; text-align: center; }
  .sp-log-list, .sp-groups { display: flex; flex-direction: column; gap: 8px; }
  .sp-group { display: flex; flex-direction: column; gap: 4px; }
  .sp-group-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: .5px;
    color: var(--primary);
    padding: 2px 0;
    border-bottom: 1px solid var(--border);
  }
  .sp-log {
    padding: 8px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .sp-log-title { font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sp-log-meta { font-size: 11px; color: var(--dim); margin-top: 2px; }
  .ok { color: var(--success); }
  .bad { color: var(--error); }
  .sp-skill { font-size: 12px; padding: 2px 0; }
  .sp-skill-name { font-weight: 500; color: var(--text); }
  .sp-skill-desc {
    font-size: 11px;
    color: var(--dim);
    margin-top: 2px;
    line-height: 1.5;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
</style>
