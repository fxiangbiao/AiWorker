<script lang="ts">
  import { onMount } from "svelte";
  import { API } from "$lib/stores/chat.svelte";
  import TracePanel from "./TracePanel.svelte";

  let tab = $state<"context" | "logs" | "skills" | "mcp" | "trace" | "plugins">("context");
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

  interface SkillCard {
    name: string;
    version: string;
    description: string;
    expert: string;
    triggers: string[];
    body: string;
    raw: string;
  }
  let skillList = $state<SkillCard[]>([]);
  let detail: SkillCard | null = $state(null);
  let loading = $state(false);

  interface McpServer {
    name: string;
    transport: string;
    connected: boolean;
    toolCount: number;
    state?: string;
    error?: string;
    tools?: { name: string; description: string }[];
  }
  let mcpServers = $state<McpServer[]>([]);
  let mcpExpanded = $state<string | null>(null);

  interface PluginCard {
    name: string;
    version?: string;
    description?: string;
    status: string;
    error?: string;
    warnings?: string[];
    registeredTools: string[];
    registeredHooks: number;
  }
  let pluginList = $state<PluginCard[]>([]);

  const mcpStateLabel: Record<string, string> = {
    connected: "已连接",
    connecting: "连接中",
    reconnecting: "重连中",
    disconnected: "未连接",
    dead: "已失效",
  };

  let groups = $derived.by(() => {
    const byExpert = new Map<string, SkillCard[]>();
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
          if (typeof s === "string") return { name: s, version: "1.0", description: "", expert: "", triggers: [], body: "", raw: "" };
          const o = s as Record<string, unknown>;
          return {
            name: (o.name as string) ?? "",
            version: (o.version as string) ?? "1.0",
            description: (o.description as string) ?? "",
            expert: (o.expert as string) ?? "",
            triggers: ((o.triggers as string[]) ?? []) as string[],
            body: (o.body as string) ?? "",
            raw: (o.raw as string) ?? "",
          };
        });
      })
      .catch(() => { skillList = []; })
      .finally(() => { loading = false; });
  }

  function loadMcp() {
    loading = true;
    fetch(`${API}/mcp`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { mcpServers = (d.servers || []) as McpServer[]; })
      .catch(() => { mcpServers = []; })
      .finally(() => { loading = false; });
  }

  function loadPlugins() {
    loading = true;
    fetch(`${API}/plugins`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { pluginList = (d.plugins || []) as PluginCard[]; })
      .catch(() => { pluginList = []; })
      .finally(() => { loading = false; });
  }

  function switchTab(t: "context" | "logs" | "skills" | "mcp" | "trace" | "plugins") {
    tab = t;
    detail = null;
    if (t === "context") loadContext();
    else if (t === "logs") loadLogs();
    else if (t === "skills") loadSkills();
    else if (t === "mcp") loadMcp();
    else if (t === "plugins") loadPlugins();
  }

  onMount(() => loadContext());
</script>

<div class="sys-panel">
  <div class="sp-tabs">
    <button class="sp-tab" class:active={tab === "context"} onclick={() => switchTab("context")}>上下文</button>
    <button class="sp-tab" class:active={tab === "logs"} onclick={() => switchTab("logs")}>日志</button>
    <button class="sp-tab" class:active={tab === "skills"} onclick={() => switchTab("skills")}>技能</button>
    <button class="sp-tab" class:active={tab === "mcp"} onclick={() => switchTab("mcp")}>MCP</button>
    <button class="sp-tab" class:active={tab === "plugins"} onclick={() => switchTab("plugins")}>插件</button>
    <button class="sp-tab" class:active={tab === "trace"} onclick={() => switchTab("trace")}>轨迹</button>
  </div>

  <div class="sp-body">
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
    {:else if tab === "trace"}
      <TracePanel />
    {:else if tab === "mcp"}
      {#if mcpServers.length === 0}
        <div class="sp-empty">暂无 MCP 服务器</div>
      {:else}
        <div class="sp-mcp-list">
          {#each mcpServers as s}
            <div class="sp-mcp">
              <div class="sp-mcp-head" onclick={() => (mcpExpanded = mcpExpanded === s.name ? null : s.name)} role="button" tabindex="0" onkeydown={(e) => e.key === "Enter" && (mcpExpanded = mcpExpanded === s.name ? null : s.name)}>
                <span class="sp-mcp-name">{s.name}</span>
                <span class="sp-mcp-right">
                  <span class="sp-dot" class:on={s.connected} class:off={!s.connected}>
                    {s.connected ? "已连接" : mcpStateLabel[s.state || "disconnected"] || "未连接"}
                  </span>
                  <span class="sp-caret">{mcpExpanded === s.name ? "▼" : "▶"}</span>
                </span>
              </div>
              <div class="sp-mcp-meta">传输: {s.transport} · 工具: {s.toolCount}</div>
              {#if s.error}
                <div class="sp-mcp-error">{s.error}</div>
              {/if}
              {#if mcpExpanded === s.name}
                <div class="sp-mcp-tools">
                  {#if (s.tools || []).length === 0}
                    <div class="sp-mcp-notools">该服务器暂无工具（可能未连接）</div>
                  {:else}
                    {#each s.tools || [] as t}
                      <div class="sp-mcp-tool">
                        <div class="sp-mcp-tool-name">{t.name}</div>
                        {#if t.description}
                          <div class="sp-mcp-tool-desc">{t.description}</div>
                        {/if}
                      </div>
                    {/each}
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    {:else if tab === "plugins"}
      {#if pluginList.length === 0}
        <div class="sp-empty">暂无插件（config/plugins/）</div>
      {:else}
        <div class="sp-mcp-list">
          {#each pluginList as p}
            <div class="sp-mcp">
              <div class="sp-mcp-head">
                <span class="sp-mcp-name">{p.name}</span>
                <span class="sp-mcp-right">
                  {#if p.version}
                    <span class="sp-card-ver">v{p.version}</span>
                  {/if}
                  <span class="sp-dot" class:on={p.status === "loaded"} class:off={p.status !== "loaded"}>
                    {p.status === "loaded" ? "已加载" : "加载失败"}
                  </span>
                </span>
              </div>
              {#if p.description}
                <div class="sp-mcp-meta">{p.description}</div>
              {/if}
              <div class="sp-mcp-meta">{p.registeredTools.length} 工具 · {p.registeredHooks} hook</div>
              {#if p.error}
                <div class="sp-mcp-error">{p.error}</div>
              {/if}
              {#each p.warnings || [] as w}
                <div class="sp-warn">{w}</div>
              {/each}
              {#if p.registeredTools.length > 0}
                <div class="sp-mcp-tools">
                  {#each p.registeredTools as t}
                    <div class="sp-mcp-tool">
                      <div class="sp-mcp-tool-name">{t}</div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    {:else}
      {#if skillList.length === 0}
        <div class="sp-empty">暂无技能</div>
      {:else if detail}
        <div class="sp-detail">
          <div class="sp-detail-back" onclick={() => (detail = null)}>&#8592; 返回技能列表</div>
          <div class="sp-detail-name">{detail.name} <span class="sp-detail-ver">v{detail.version}</span></div>
          <div class="sp-detail-expert">{detail.expert}</div>
          {#if detail.description}
            <div class="sp-detail-desc">{detail.description}</div>
          {/if}
          {#if detail.triggers.length > 0}
            <div class="sp-detail-sec">触发词</div>
            <div class="sp-detail-tags">
              {#each detail.triggers as t}
                <span class="sp-tag">{t}</span>
              {/each}
            </div>
          {/if}
          {#if detail.raw || detail.body}
            <div class="sp-detail-sec">内容</div>
            <pre class="sp-detail-body">{detail.raw || detail.body}</pre>
          {/if}
        </div>
      {:else}
        <div class="sp-groups">
          {#each groups as [expert, skills]}
            <div class="sp-group">
              <div class="sp-group-title">{expert || "general"}</div>
              <div class="sp-cards">
                {#each skills as s}
                  <div
                    class="sp-card"
                    onclick={() => (detail = s)}
                    onkeydown={(e) => e.key === "Enter" && (detail = s)}
                    role="button"
                    tabindex="0"
                  >
                    <div class="sp-card-head">
                      <span class="sp-card-name">{s.name}</span>
                      <span class="sp-card-ver">v{s.version}</span>
                    </div>
                    {#if s.description}
                      <div class="sp-card-desc">{s.description}</div>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .sys-panel { display: flex; flex-direction: column; gap: 10px; flex: 1; min-height: 0; }
  .sp-tabs { display: flex; gap: 4px; flex-shrink: 0; border-bottom: 1px solid var(--border); }
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
  .sp-body { flex: 1; overflow-y: auto; min-height: 0; }
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
  .sp-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .sp-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    background: var(--surface);
    cursor: pointer;
    transition: border-color .15s, box-shadow .15s;
  }
  .sp-card:hover { border-color: var(--primary); box-shadow: var(--shadow); }
  .sp-card-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .sp-card-name { font-size: 12px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sp-card-ver { font-size: 10px; color: var(--primary); flex-shrink: 0; }
  .sp-card-desc {
    font-size: 11px;
    color: var(--dim);
    margin-top: 4px;
    line-height: 1.5;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .sp-detail-back { font-size: 11px; color: var(--primary); cursor: pointer; margin-bottom: 8px; }
  .sp-detail-name { font-size: 14px; font-weight: 600; color: var(--text); }
  .sp-detail-ver { font-size: 11px; color: var(--primary); font-weight: 500; }
  .sp-detail-expert { font-size: 11px; color: var(--dim); margin-top: 2px; }
  .sp-detail-desc { font-size: 12px; color: var(--text); margin: 8px 0; line-height: 1.6; }
  .sp-detail-sec { font-size: 11px; font-weight: 600; color: var(--dim); margin: 12px 0 6px; text-transform: uppercase; letter-spacing: .5px; }
  .sp-detail-tags { display: flex; flex-wrap: wrap; gap: 6px; }
  .sp-tag {
    font-size: 11px;
    padding: 2px 8px;
    background: var(--primary-light);
    color: var(--primary);
    border-radius: 10px;
    font-family: var(--font-mono);
  }
  .sp-detail-body {
    font-family: var(--font-mono);
    font-size: 11px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text);
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
  .sp-mcp-list { display: flex; flex-direction: column; gap: 8px; }
  .sp-mcp {
    padding: 10px 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .sp-mcp-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer; }
  .sp-mcp-name { font-size: 12px; font-weight: 600; font-family: var(--font-mono); }
  .sp-mcp-right { display: flex; align-items: center; gap: 8px; }
  .sp-caret { font-size: 10px; color: var(--dim); }
  .sp-mcp-tools { margin-top: 8px; border-top: 1px dashed var(--border); padding-top: 8px; display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow-y: auto; }
  .sp-mcp-tool { padding: 6px 8px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .sp-mcp-tool-name { font-size: 11px; font-weight: 600; font-family: var(--font-mono); color: var(--text); }
  .sp-mcp-tool-desc { font-size: 11px; color: var(--dim); margin-top: 2px; line-height: 1.5; }
  .sp-mcp-notools { font-size: 11px; color: var(--dim); padding: 8px; text-align: center; }
  .sp-dot {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 10px;
    font-weight: 500;
  }
  .sp-dot.on { background: rgba(34, 197, 94, .12); color: #16a34a; }
  .sp-dot.off { background: rgba(232, 84, 107, .1); color: var(--error); }
  .sp-mcp-meta { font-size: 11px; color: var(--dim); margin-top: 4px; }
  .sp-mcp-error { font-size: 11px; color: var(--error); margin-top: 4px; word-break: break-word; }
  .sp-warn { font-size: 11px; color: #d97706; margin-top: 4px; word-break: break-word; }
</style>
