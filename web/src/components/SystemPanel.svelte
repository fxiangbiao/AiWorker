<script lang="ts">
  import { onMount } from "svelte";
  import { API } from "$lib/stores/chat.svelte";
  import { onWsEvent } from "$lib/stores/ws.svelte";
  import TracePanel from "./TracePanel.svelte";

  let tab = $state<"context" | "logs" | "skills" | "mcp" | "plugins" | "schedule" | "trace">("context");
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

  interface SchedCard {
    id: string;
    cron: string;
    prompt: string;
    agentId: string;
  }
  let schedList = $state<SchedCard[]>([]);

  interface JobCard {
    id: string;
    agentId: string;
    prompt: string;
    status: string;
    summary: string;
    error?: string;
    startedAt?: number;
    finishedAt?: number;
  }
  let jobList = $state<JobCard[]>([]);
  let newCron = $state("0 8 * * *");
  let newPrompt = $state("");
  let newNlPrompt = $state("");
  let newAgent = $state("default");
  let schedMsg = $state("");

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

  function loadSchedule() {
    loading = true;
    Promise.all([
      fetch(`${API}/schedule`).then((r) => (r.ok ? r.json() : Promise.reject())),
      fetch(`${API}/jobs`).then((r) => (r.ok ? r.json() : Promise.reject())),
    ])
      .then(([s, j]) => {
        schedList = (s.jobs || []) as SchedCard[];
        jobList = (j.jobs || []) as JobCard[];
      })
      .catch(() => { schedList = []; jobList = []; })
      .finally(() => { loading = false; });
  }

  function addSchedule() {
    const nl = newNlPrompt.trim();
    const prompt = newPrompt.trim();
    if (!nl && !prompt) { schedMsg = "请输入任务描述（自然语言或 cron+任务）"; return; }
    schedMsg = "";
    fetch(`${API}/schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 自然语言优先（后端解析为 cron）；否则用 cron + 任务
      body: JSON.stringify(
        nl
          ? { prompt: nl, agentId: newAgent.trim() || "default" }
          : { cron: newCron.trim(), prompt, agentId: newAgent.trim() || "default" },
      ),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { schedMsg = d.error; return; }
        newPrompt = "";
        newNlPrompt = "";
        loadSchedule();
      })
      .catch(() => { schedMsg = "添加失败"; });
  }

  function removeSchedule(id: string) {
    fetch(`${API}/schedule/${id}`, { method: "DELETE" })
      .then(() => loadSchedule())
      .catch(() => {});
  }

  function cancelJob(id: string) {
    fetch(`${API}/jobs/${id}`, { method: "DELETE" })
      .then(() => loadSchedule())
      .catch(() => {});
  }

  const jobStatusLabel: Record<string, string> = {
    queued: "排队中",
    running: "运行中",
    done: "完成",
    failed: "失败",
  };

  // ── .aw 资产包导入/导出 ──

  async function exportAsset(type: "skill" | "mcp" | "plugin", name: string) {
    try {
      const resp = await fetch(`${API}/packages/export?type=${type}&name=${encodeURIComponent(name)}`);
      if (!resp.ok) return;
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${name}.aw`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      /* 忽略 */
    }
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const buf = reader.result as ArrayBuffer;
        const bytes = new Uint8Array(buf);
        let bin = "";
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
        resolve(btoa(bin));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  }

  /** 选择 .aw 文件：先 peek manifest → 安全确认 → 导入 */
  function importAsset() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".aw,application/octet-stream";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const data = await fileToBase64(file);
      const peekResp = await fetch(`${API}/packages/peek`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
      });
      const peek = (await peekResp.json()) as { ok: boolean; type?: string; name?: string; version?: string; error?: string };
      if (!peekResp.ok) {
        alert(`不是有效的 .aw 包: ${peek.error ?? peekResp.status}`);
        return;
      }
      // 安全确认：插件执行代码 / MCP 启动进程
      if (peek.type === "plugin" && !confirm(`⚠️ 导入插件会执行其中的代码（第三方插件可能有风险）。继续导入「${peek.name}」？`)) return;
      if (peek.type === "mcp" && !confirm(`⚠️ 导入 MCP 会启动外部进程/连接服务。继续导入「${peek.name}」？`)) return;
      if (peek.type === "skill" && !confirm(`导入技能「${peek.name}」v${peek.version}？`)) return;

      let resp = await fetch(`${API}/packages/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
      });
      if (!resp.ok) {
        const r = (await resp.json()) as { error?: string; success?: boolean };
        if (!r.success && r.error && r.error.includes("已存在")) {
          if (confirm(`同名资产已存在。覆盖？`)) {
            resp = await fetch(`${API}/packages/import`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ data, force: true }),
            });
          } else {
            return;
          }
        }
      }
      if (resp.ok) {
        loadSkills();
        loadMcp();
        loadPlugins();
        alert(`导入成功: ${peek.type}「${peek.name}」`);
      } else {
        const r = (await resp.json()) as { error?: string };
        alert(`导入失败: ${r.error ?? resp.status}`);
      }
    };
    input.click();
  }

  function switchTab(t: "context" | "logs" | "skills" | "mcp" | "plugins" | "schedule" | "trace") {
    tab = t;
    detail = null;
    if (t === "context") loadContext();
    else if (t === "logs") loadLogs();
    else if (t === "skills") loadSkills();
    else if (t === "mcp") loadMcp();
    else if (t === "plugins") loadPlugins();
    else if (t === "schedule") loadSchedule();
  }

  // WS job/done 事件 → 调度 Tab 数据实时刷新
  let unsubWs: (() => void) | null = null;

  onMount(() => {
    loadContext();
    unsubWs = onWsEvent((d) => {
      if ((d as { type?: string }).type === "job/done") loadSchedule();
    });
  });
</script>

<div class="sys-panel">
  <div class="sp-side">
    <button class="sp-nav" class:active={tab === "context"} onclick={() => switchTab("context")}>上下文</button>
    <button class="sp-nav" class:active={tab === "logs"} onclick={() => switchTab("logs")}>日志</button>
    <button class="sp-nav" class:active={tab === "skills"} onclick={() => switchTab("skills")}>技能</button>
    <button class="sp-nav" class:active={tab === "mcp"} onclick={() => switchTab("mcp")}>MCP</button>
    <button class="sp-nav" class:active={tab === "plugins"} onclick={() => switchTab("plugins")}>插件</button>
    <button class="sp-nav" class:active={tab === "schedule"} onclick={() => switchTab("schedule")}>调度</button>
    <button class="sp-nav" class:active={tab === "trace"} onclick={() => switchTab("trace")}>轨迹</button>
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
      <div class="sp-io-bar"><button class="sp-io-btn" onclick={importAsset}>导入 .aw</button></div>
      {#if mcpServers.length === 0}
        <div class="sp-empty">暂无 MCP 服务器</div>
      {:else}
        <div class="sp-mcp-list">
          {#each mcpServers as s}
            <div class="sp-mcp">
              <div class="sp-mcp-head" onclick={() => (mcpExpanded = mcpExpanded === s.name ? null : s.name)} role="button" tabindex="0" onkeydown={(e) => e.key === "Enter" && (mcpExpanded = mcpExpanded === s.name ? null : s.name)}>
                <span class="sp-mcp-name">{s.name}</span>
                <span class="sp-mcp-right">
                  <button class="sp-io-mini" onclick={(e) => { e.stopPropagation(); exportAsset("mcp", s.name); }}>导出</button>
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
      <div class="sp-io-bar"><button class="sp-io-btn" onclick={importAsset}>导入 .aw</button></div>
      {#if pluginList.length === 0}
        <div class="sp-empty">暂无插件（config/plugins/）</div>
      {:else}
        <div class="sp-mcp-list">
          {#each pluginList as p}
            <div class="sp-mcp">
              <div class="sp-mcp-head">
                <span class="sp-mcp-name">{p.name}</span>
                <span class="sp-mcp-right">
                  <button class="sp-io-mini" onclick={(e) => { e.stopPropagation(); exportAsset("plugin", p.name); }}>导出</button>
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
    {:else if tab === "schedule"}
      <div class="sp-section"><div class="sp-row"><span>定时任务（config/schedule.json）</span></div></div>
      {#if schedList.length === 0}
        <div class="sp-empty">暂无定时任务</div>
      {:else}
        <div class="sp-mcp-list">
          {#each schedList as s}
            <div class="sp-mcp">
              <div class="sp-mcp-head">
                <span class="sp-mcp-name">{s.cron}</span>
                <span class="sp-mcp-right">
                  <span class="sp-mcp-meta">{s.agentId}</span>
                  <button class="sp-del" onclick={() => removeSchedule(s.id)}>删除</button>
                </span>
              </div>
              <div class="sp-mcp-meta">{s.prompt}</div>
            </div>
          {/each}
        </div>
      {/if}
      <div class="sp-sched-form">
        <input class="sp-sched-input" bind:value={newNlPrompt} placeholder="自然语言，如：每天早上8点生成早报" />
        <input class="sp-sched-input sp-sched-agent" bind:value={newAgent} placeholder="专家" />
        <button class="sp-sched-btn" onclick={addSchedule}>添加定时任务</button>
      </div>
      <div class="sp-sched-form sp-sched-alt">
        <span class="sp-sched-hint">或直接填 cron：</span>
        <input class="sp-sched-input" bind:value={newCron} placeholder="cron 5 字段，如 0 8 * * *" />
        <input class="sp-sched-input" bind:value={newPrompt} placeholder="任务描述" />
      </div>
      {#if schedMsg}
        <div class="sp-mcp-error">{schedMsg}</div>
      {/if}
      <div class="sp-section"><div class="sp-row"><span>后台任务（/bg 或 POST /api/v1/jobs）</span></div></div>
      {#if jobList.length === 0}
        <div class="sp-empty">暂无后台任务</div>
      {:else}
        <div class="sp-mcp-list">
          {#each jobList as j}
            <div class="sp-mcp">
              <div class="sp-mcp-head">
                <span class="sp-mcp-name">{j.id}</span>
                <span class="sp-mcp-right">
                  <span class="sp-dot" class:on={j.status === "done"} class:off={j.status !== "done"}>
                    {jobStatusLabel[j.status] || j.status}
                  </span>
                  {#if j.status === "queued"}
                    <button class="sp-del" onclick={() => cancelJob(j.id)}>取消</button>
                  {/if}
                </span>
              </div>
              <div class="sp-mcp-meta">{j.agentId} · {(j.summary || j.error || j.prompt).slice(0, 80)}</div>
            </div>
          {/each}
        </div>
      {/if}
    {:else}
      <div class="sp-io-bar"><button class="sp-io-btn" onclick={importAsset}>导入 .aw</button></div>
      {#if skillList.length === 0}
        <div class="sp-empty">暂无技能</div>
      {:else if detail}
        <div class="sp-detail">
          <div class="sp-detail-back" onclick={() => (detail = null)}>&#8592; 返回技能列表</div>
          <div class="sp-detail-name">
            {detail.name} <span class="sp-detail-ver">v{detail.version}</span>
            <button class="sp-io-mini sp-io-mini-inline" onclick={() => exportAsset("skill", detail.name)}>导出</button>
          </div>
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
  .sys-panel { display: flex; gap: 0; flex: 1; min-height: 0; }
  .sp-side {
    width: 92px;
    flex-shrink: 0;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
    overflow-y: auto;
    min-height: 0;
  }
  .sp-nav {
    padding: 8px 10px;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--dim);
    font-family: var(--font-ui);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    text-align: left;
  }
  .sp-nav:hover { background: var(--hover-bg); color: var(--text); }
  .sp-nav.active { background: var(--primary-light); color: var(--primary); }
  .sp-body { flex: 1; overflow-y: auto; min-height: 0; padding-left: 14px; }
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
  .sp-sched-form { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; padding: 10px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .sp-sched-alt { margin-top: 6px; }
  .sp-sched-hint { font-size: 11px; color: var(--dim); }
  .sp-sched-input { font-size: 11px; font-family: var(--font-mono); padding: 6px 8px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text); }
  .sp-sched-agent { font-family: var(--font-ui); }
  .sp-sched-btn { padding: 6px 10px; background: var(--primary); color: #fff; border: none; border-radius: var(--radius-sm); font-size: 12px; cursor: pointer; }
  .sp-sched-btn:hover { filter: brightness(1.1); }
  .sp-del { padding: 2px 8px; font-size: 11px; background: transparent; border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--dim); cursor: pointer; }
  .sp-del:hover { color: var(--error); border-color: var(--error); }
  .sp-io-bar { margin-bottom: 8px; display: flex; justify-content: flex-end; }
  .sp-io-btn { padding: 5px 12px; font-size: 11px; background: var(--primary-light); color: var(--primary); border: none; border-radius: var(--radius-sm); cursor: pointer; font-weight: 600; }
  .sp-io-btn:hover { filter: brightness(1.05); }
  .sp-io-mini { padding: 1px 8px; font-size: 10px; background: transparent; border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--dim); cursor: pointer; }
  .sp-io-mini:hover { color: var(--primary); border-color: var(--primary); }
  .sp-io-mini-inline { margin-left: 8px; vertical-align: middle; }
</style>
