<script lang="ts">
  import { onMount } from "svelte";
  import { RefreshCw } from "lucide-svelte";
  import { API, store } from "$lib/stores/chat.svelte";
  import { refreshStatus } from "$lib/stores/status";
  import { onWsEvent } from "$lib/stores/ws.svelte";
  import TracePanel from "./TracePanel.svelte";
  import AppsPanel from "./AppsPanel.svelte";
  import ProcessesPanel from "./ProcessesPanel.svelte";
  import AgentsPanel from "./AgentsPanel.svelte";
  import EvolutionPanel from "./EvolutionPanel.svelte";

  type SystemTab = "context" | "skills" | "mcp" | "plugins" | "apps" | "processes" | "schedule" | "config" | "trace" | "agents" | "evolution" | "audit" | "devices";
  let tab = $state<SystemTab>("context");
  let breakdown: {
    systemPromptBase?: number;
    projectMemory?: number;
    userProfile?: number;
    episodicMemory?: number;
    injectedSkills?: number;
    conversationHistory?: number;
    currentTurn?: number;
    total?: number;
    windowSize?: number;
    remaining?: number;
    skillsMatched?: string[];
    skillsTotal?: number;
  } = $state({});
  /** 上下文 Tab 状态：按当前选中会话（Sprint 44）；本地未建服务器会话时提示 */
  let ctxError = $state("");
  /** loadContext 请求代际：快速切换会话/离开 Tab 时丢弃过期响应，防旧 breakdown 覆盖新会话 */
  let ctxReqSeq = 0;

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
  /** 技能检索（Sprint 37）：名称/描述/专家/触发词过滤 */
  let skillQuery = $state("");
  let loading = $state(false);

  // ── 审计 Tab（Sprint 42 A1：全量操作审计可查） ──
  interface AuditEntry {
    timestamp: number;
    agentId: string;
    sessionId: string;
    action: string;
    target?: string;
    result: "success" | "blocked" | "error";
    detail?: string;
  }
  let auditEntries = $state<AuditEntry[]>([]);
  let auditFilter = $state("");
  const AUDIT_CHIPS = [
    { id: "", label: "全部" },
    { id: "app:", label: "应用" },
    { id: "evolution:", label: "进化" },
    { id: "session:", label: "会话" },
    { id: "tool:", label: "工具" },
  ];
  const filteredAudit = $derived(auditFilter ? auditEntries.filter((e) => e.action.startsWith(auditFilter)) : auditEntries);

  async function loadAudit() {
    try {
      const r = await fetch(`${API}/audit?limit=200`);
      if (r.ok) auditEntries = ((await r.json()) as { entries: AuditEntry[] }).entries ?? [];
    } catch {
      auditEntries = [];
    }
  }

  function fmtAuditAt(ts?: number): string {
    if (!ts) return "-";
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // ── 设备 Tab（Sprint 42 A2：媒体通道 + 模型能力，只读；Sprint 43：一键下载语音模型） ──
  interface DeviceStatus {
    asr: { enabled: boolean; engine: string; detail: string };
    tts: { engine: string; localModelReady: boolean; detail: string };
    mediaServer: { active: boolean; path?: string; clients?: number };
    model: { current: string; vision: boolean; contextWindow?: number; detail: string };
  }
  let deviceStatus = $state<DeviceStatus | null>(null);
  let mediaBusy = $state<"" | "asr" | "tts">("");
  let msg = $state<{ kind: "ok" | "err"; text: string } | null>(null);

  async function loadDevices() {
    try {
      const r = await fetch(`${API}/devices`);
      if (r.ok) deviceStatus = (await r.json()) as DeviceStatus;
    } catch {
      deviceStatus = null;
    }
  }

  /** 一键下载语音模型（hf-mirror；约 232MB(ASR)/118MB(TTS)，本地 fetch 等待完成） */
  async function downloadMedia(kind: "asr" | "tts") {
    if (mediaBusy) return;
    mediaBusy = kind;
    try {
      const r = await fetch(`${API}/media/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const d = (await r.json()) as { ok?: boolean; downloaded?: string[]; skipped?: string[]; error?: string };
      if (!r.ok || !d.ok) msg = { kind: "err", text: d.error ?? `下载失败（HTTP ${r.status}）` };
      else msg = { kind: "ok", text: `模型下载完成（新增 ${d.downloaded?.length ?? 0} · 跳过 ${d.skipped?.length ?? 0}）` };
      await loadDevices();
    } catch (e) {
      msg = { kind: "err", text: (e as Error).message };
    } finally {
      mediaBusy = "";
    }
  }

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

  /** 技能检索：按名称/描述/专家/触发词过滤后分组 */
  let filteredGroups = $derived.by(() => {
    const q = skillQuery.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map(([expert, skills]) => [
        expert,
        skills.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q) ||
            s.expert.toLowerCase().includes(q) ||
            s.triggers.some((t) => t.toLowerCase().includes(q)),
        ),
      ] as [string, SkillCard[]])
      .filter(([, list]) => list.length > 0);
  });

  function fmtTok(t?: number): string {
    if (t === undefined) return "-";
    if (t >= 1000) return `${(t / 1000).toFixed(1)}k`;
    return String(t);
  }

  function fmtWin(n?: number): string {
    if (!n) return "-";
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
    return String(n);
  }

  /** 上下文按当前选中会话统计（Sprint 44）；本地新对话未建服务器会话 → 404 空态提示；代际守卫防快速切换会话时旧响应覆盖 */
  function loadContext() {
    const seq = ++ctxReqSeq;
    loading = true;
    ctxError = "";
    const sid = store.activeChatId ? `?sessionId=${encodeURIComponent(store.activeChatId)}` : "";
    fetch(`${API}/context${sid}`)
      .then(async (r) => {
        if (seq !== ctxReqSeq) return null;
        if (r.status === 404) {
          breakdown = {};
          ctxError = "该会话尚未在服务器建立（发送首条消息后可见）";
          return null;
        }
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d) => { if (seq === ctxReqSeq && d) breakdown = d.breakdown || {}; })
      .catch(() => { if (seq === ctxReqSeq) breakdown = {}; })
      .finally(() => { if (seq === ctxReqSeq) loading = false; });
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

  // ── 系统配置（等价 TUI /config；迭代上限已统一由「智能体」Tab 管理） ──
  interface ConfigState {
    model: string;
    availableModels: { key: string; model: string; provider: string }[];
    runtimeConfig: { profileKey?: string; temperature?: number | null; maxTokens?: number | null };
    thinking: boolean;
    skillEvo: boolean;
    appVersion: string;
  }
  let configState = $state<ConfigState | null>(null);
  let cfgModel = $state("default");
  let cfgTemperature = $state("");
  let cfgMaxTokens = $state("");
  let cfgMsg = $state("");
  // 添加模型表单
  let newModelKey = $state("");
  let newModelName = $state("");
  let newModelBase = $state("");
  let newModelProvider = $state("");
  let newModelKeyVal = $state("");

  function loadConfig() {
    loading = true;
    fetch(`${API}/config`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        configState = d as ConfigState;
        cfgModel = configState.runtimeConfig.profileKey || "default";
        cfgTemperature = configState.runtimeConfig.temperature != null ? String(configState.runtimeConfig.temperature) : "";
        cfgMaxTokens = configState.runtimeConfig.maxTokens != null ? String(configState.runtimeConfig.maxTokens) : "";
      })
      .catch(() => { configState = null; })
      .finally(() => { loading = false; });
  }

  async function applyConfig(field: string, value: unknown): Promise<boolean> {
    cfgMsg = "";
    const resp = await fetch(`${API}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field, value }),
    });
    const data = (await resp.json()) as { ok?: boolean; error?: string; state?: ConfigState };
    if (!resp.ok || !data.ok) {
      cfgMsg = `设置失败: ${data.error ?? resp.status}`;
      return false;
    }
    if (data.state) configState = data.state;
    // 立即刷新底部状态栏（模型/窗口等），避免等 30s 轮询或下一轮 done
    void refreshStatus();
    loadConfig();
    return true;
  }

  function onModelChange(e: Event) {
    void applyConfig("model", (e.target as HTMLSelectElement).value);
  }
  function onTemperature() {
    void applyConfig("temperature", parseFloat(cfgTemperature));
  }
  function onMaxTokens() {
    void applyConfig("maxTokens", parseInt(cfgMaxTokens, 10));
  }
  function onThinking(e: Event) {
    void applyConfig("thinking", (e.target as HTMLInputElement).checked);
  }
  function onSkillEvo(e: Event) {
    void applyConfig("skillEvo", (e.target as HTMLInputElement).checked);
  }
  function onReset() {
    if (!confirm("恢复配置文件默认（模型/温度/max-tokens）？")) return;
    void applyConfig("reset", null);
  }

  function onAddModel() {
    if (!newModelKey.trim() || !newModelName.trim() || !newModelBase.trim()) {
      cfgMsg = "添加模型需填写 key / 模型名 / baseURL";
      return;
    }
    void applyConfig("addModel", {
      key: newModelKey.trim(),
      model: newModelName.trim(),
      baseURL: newModelBase.trim(),
      provider: newModelProvider.trim() || undefined,
      apiKey: newModelKeyVal.trim() || undefined,
    }).then((ok) => {
      if (ok) {
        newModelKey = "";
        newModelName = "";
        newModelBase = "";
        newModelProvider = "";
        newModelKeyVal = "";
      }
    });
  }

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

  /** 选择文件导入：.aw 包 / 裸 SKILL.md / 裸 MCP 配置（先 peek → 安全确认 → 导入） */
  function importAsset() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".aw,.md,.json,application/octet-stream,text/markdown";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const filename = file.name;
      const data = await fileToBase64(file);
      const peekResp = await fetch(`${API}/packages/peek`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data, filename }),
      });
      const peek = (await peekResp.json()) as { ok: boolean; type?: string; name?: string; version?: string; error?: string };
      if (!peekResp.ok) {
        alert(`无法识别包: ${peek.error ?? peekResp.status}`);
        return;
      }
      // 安全确认：插件执行代码 / MCP 启动进程
      if (peek.type === "plugin" && !confirm(`⚠️ 导入插件会执行其中的代码（第三方插件可能有风险）。继续导入「${peek.name}」？`)) return;
      if (peek.type === "mcp" && !confirm(`⚠️ 导入 MCP 会启动外部进程/连接服务。继续导入「${peek.name}」？`)) return;
      if (peek.type === "skill" && !confirm(`导入技能「${peek.name}」v${peek.version}？`)) return;

      let resp = await fetch(`${API}/packages/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data, filename }),
      });
      if (!resp.ok) {
        const r = (await resp.json()) as { error?: string; success?: boolean };
        if (!r.success && r.error && r.error.includes("已存在")) {
          if (confirm(`同名资产已存在。覆盖？`)) {
            resp = await fetch(`${API}/packages/import`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ data, filename, force: true }),
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

  /** 导出裸格式（技能 .md / MCP .json） */
  async function exportRawAsset(type: "skill" | "mcp", name: string) {
    try {
      const resp = await fetch(`${API}/packages/export?type=${type}&name=${encodeURIComponent(name)}&raw=1`);
      if (!resp.ok) return;
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = type === "skill" ? `${name}.md` : `${name}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      /* 忽略 */
    }
  }

  function switchTab(t: SystemTab) {
    tab = t;
    detail = null;
    if (t === "skills") loadSkills();
    else if (t === "mcp") loadMcp();
    else if (t === "plugins") loadPlugins();
    else if (t === "schedule") loadSchedule();
    else if (t === "config") loadConfig();
    else if (t === "audit") loadAudit();
    else if (t === "devices") loadDevices();
    // context Tab 由下方 $effect 驱动（切到 context 时 loadContext）
  }
  // WS job/done 事件 → 调度 Tab 数据实时刷新
  let unsubWs: (() => void) | null = null;

  onMount(() => {
    unsubWs = onWsEvent((d) => {
      if ((d as { type?: string }).type === "job/done") loadSchedule();
    });
  });

  // 上下文 Tab：挂载/切到该 Tab/切换会话/消息更新时自动重算（读取不写，避免自触发）
  $effect(() => {
    void store.activeChatId;
    void store.diffVersion;
    if (tab === "context") loadContext();
  });
</script>

<div class="sys-panel">
  {#snippet ContextRow(label: string, tok: number | undefined, win: number | undefined)}
    {@const pct = win && win > 0 ? Math.min(100, ((tok ?? 0) / win) * 100) : 0}
    <div class="sp-row-ctx" title={`${fmtTok(tok)} tok（估算）`}>
      <div class="sp-row-ctx-top">
        <span>{label}</span>
        <b>{fmtTok(tok)}</b>
        <span class="sp-ctx-pct">{(tok ?? 0) > 0 ? pct.toFixed(2) + "%" : ""}</span>
      </div>
      <div class="sp-ctx-bar"><i class="sp-ctx-fill" style="width:{pct}%"></i></div>
    </div>
  {/snippet}
  <div class="sp-side">
    <button class="sp-nav" class:active={tab === "context"} onclick={() => switchTab("context")}>上下文</button>
    <button class="sp-nav" class:active={tab === "agents"} onclick={() => switchTab("agents")}>智能体</button>
    <button class="sp-nav" class:active={tab === "skills"} onclick={() => switchTab("skills")}>技能</button>
    <button class="sp-nav" class:active={tab === "mcp"} onclick={() => switchTab("mcp")}>MCP</button>
    <button class="sp-nav" class:active={tab === "plugins"} onclick={() => switchTab("plugins")}>插件</button>
    <button class="sp-nav" class:active={tab === "apps"} onclick={() => switchTab("apps")}>应用</button>
    <button class="sp-nav" class:active={tab === "processes"} onclick={() => switchTab("processes")}>进程</button>
    <button class="sp-nav" class:active={tab === "devices"} onclick={() => switchTab("devices")}>设备</button>
    <button class="sp-nav" class:active={tab === "evolution"} onclick={() => switchTab("evolution")}>进化</button>
    <button class="sp-nav" class:active={tab === "schedule"} onclick={() => switchTab("schedule")}>调度</button>
    <button class="sp-nav" class:active={tab === "config"} onclick={() => switchTab("config")}>配置</button>
    <button class="sp-nav" class:active={tab === "audit"} onclick={() => switchTab("audit")}>审计</button>
    <button class="sp-nav" class:active={tab === "trace"} onclick={() => switchTab("trace")}>轨迹</button>
  </div>

  <div class="sp-body">
    {#if loading}
      <div class="sp-empty">加载中...</div>
    {:else if tab === "context"}
      {#if ctxError}
        <div class="sp-empty">{ctxError}</div>
      {:else}
        <div class="sp-section">
          <div class="sp-row sp-head"><span>上下文占用（估算）</span><b>窗口 {fmtWin(breakdown.windowSize)}</b></div>
          {@render ContextRow("系统提示", breakdown.systemPromptBase, breakdown.windowSize)}
          {@render ContextRow("项目记忆", breakdown.projectMemory, breakdown.windowSize)}
          {@render ContextRow("用户画像", breakdown.userProfile, breakdown.windowSize)}
          {@render ContextRow("情景记忆", breakdown.episodicMemory, breakdown.windowSize)}
          {@render ContextRow("注入技能", breakdown.injectedSkills, breakdown.windowSize)}
          {@render ContextRow("会话历史", breakdown.conversationHistory, breakdown.windowSize)}
          {@render ContextRow("当前消息", breakdown.currentTurn, breakdown.windowSize)}
          <div class="sp-row sp-total"><span>总计</span><b>{fmtTok(breakdown.total)}</b></div>
          <div class="sp-row"><span>剩余可用</span><b>{fmtTok(breakdown.remaining)}</b></div>
          <div class="sp-note">技能 {breakdown.skillsMatched?.length ?? 0}/{breakdown.skillsTotal ?? 0} 匹配 · 估算基于 CJK≈1字/token、ASCII≈1/4字符，实际以 provider usage 为准</div>
        </div>
      {/if}
    {:else if tab === "agents"}
      <AgentsPanel />
    {:else if tab === "evolution"}
      <EvolutionPanel />
    {:else if tab === "devices"}
      <div class="sp-section">
        <div class="sp-io-bar"><button class="sp-io-btn" onclick={loadDevices}>刷新</button></div>
        {#if msg}
          <div class="sp-msg sp-msg-{msg.kind}">{msg.text}</div>
        {/if}
        {#if !deviceStatus}
          <div class="sp-empty">设备状态不可用</div>
        {:else}
          <div class="sp-dev-grid">
            <div class="sp-dev-card">
              <div class="sp-dev-head"><span class="sp-dev-dot {deviceStatus.asr.enabled ? "ok" : "off"}"></span>语音输入（ASR）</div>
              <div class="sp-dev-detail">{deviceStatus.asr.detail}</div>
              {#if !deviceStatus.asr.enabled}
                <button class="sp-dev-btn" onclick={() => downloadMedia("asr")} disabled={mediaBusy !== ""}>
                  {mediaBusy === "asr" ? "下载中…（约 232MB）" : "下载 ASR 模型"}
                </button>
              {/if}
            </div>
            <div class="sp-dev-card">
              <div class="sp-dev-head">
                <span class="sp-dev-dot ok"></span>语音输出（TTS）
                <span class="sp-dev-engine">{deviceStatus.tts.engine}</span>
                {#if deviceStatus.tts.localModelReady}<span class="sp-dev-badge">离线就绪</span>{/if}
              </div>
              <div class="sp-dev-detail">{deviceStatus.tts.detail}</div>
              {#if !deviceStatus.tts.localModelReady}
                <button class="sp-dev-btn" onclick={() => downloadMedia("tts")} disabled={mediaBusy !== ""}>
                  {mediaBusy === "tts" ? "下载中…（约 118MB）" : "下载 TTS 模型"}
                </button>
              {/if}
            </div>
            <div class="sp-dev-card">
              <div class="sp-dev-head">
                <span class="sp-dev-dot {deviceStatus.mediaServer.active ? "ok" : "off"}"></span>媒体服务器（WS 音频通道）
                {#if deviceStatus.mediaServer.clients}<span class="sp-dev-badge">{deviceStatus.mediaServer.clients} 连接</span>{/if}
              </div>
              <div class="sp-dev-detail">
                {deviceStatus.mediaServer.active ? `${deviceStatus.mediaServer.path ?? ""}（运行中）` : "未启用（浏览器端用 speechSynthesis，本通道供后端/非浏览器客户端）"}
              </div>
            </div>
            <div class="sp-dev-card">
              <div class="sp-dev-head"><span class="sp-dev-dot {deviceStatus.model.vision ? "ok" : "off"}"></span>模型能力</div>
              <div class="sp-dev-detail">
                <b>{deviceStatus.model.current}</b> · {deviceStatus.model.vision ? "🖼 支持图片输入" : "不支持视觉"}
                {#if deviceStatus.model.contextWindow}
                  <span class="sp-dev-badge">窗口 {deviceStatus.model.contextWindow >= 1000000 ? `${(deviceStatus.model.contextWindow / 1000000).toFixed(0)}M` : `${Math.round(deviceStatus.model.contextWindow / 1000)}k`}</span>
                {/if}
                <div class="sp-dev-note">{deviceStatus.model.detail}</div>
              </div>
            </div>
          </div>
        {/if}
      </div>
    {:else if tab === "audit"}
      <div class="sp-section sp-audit-section">
        <div class="sp-io-bar sp-audit-bar">
          <div class="sp-audit-chips">
            {#each AUDIT_CHIPS as chip (chip.id)}
              <button class="sp-io-btn" class:sp-chip-active={auditFilter === chip.id} onclick={() => (auditFilter = chip.id)}>{chip.label}</button>
            {/each}
          </div>
          <div class="sp-audit-right">
            <span class="sp-audit-count">{filteredAudit.length} 条</span>
            <button class="sp-io-btn sp-io-icon" title="刷新审计记录" onclick={loadAudit}><RefreshCw size={13} /></button>
          </div>
        </div>
        {#if filteredAudit.length === 0}
          <div class="sp-empty">暂无审计记录（操作后自动写入）</div>
        {:else}
          <div class="sp-audit-list">
            {#each filteredAudit as e}
              <div class="sp-audit-row">
                <span class="sp-audit-at">{fmtAuditAt(e.timestamp)}</span>
                <span class="sp-audit-result sp-result-{e.result}">{e.result === "success" ? "✓" : e.result === "blocked" ? "⛔" : "✗"}</span>
                <span class="sp-audit-action" title={e.action}>{e.action}</span>
                <span class="sp-audit-target" title={e.target}>{e.target ?? ""}</span>
                <span class="sp-audit-detail" title={e.detail}>{e.detail ?? ""}</span>
                <span class="sp-audit-session">{e.sessionId ? e.sessionId.slice(0, 8) : ""}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {:else if tab === "trace"}
      <TracePanel />
    {:else if tab === "mcp"}
      <div class="sp-io-bar"><button class="sp-io-btn" onclick={importAsset}>导入资产（.aw / .md / .json）</button></div>
      {#if mcpServers.length === 0}
        <div class="sp-empty">暂无 MCP 服务器</div>
      {:else}
        <div class="sp-mcp-list">
          {#each mcpServers as s}
            <div class="sp-mcp">
              <div class="sp-mcp-head" onclick={() => (mcpExpanded = mcpExpanded === s.name ? null : s.name)} role="button" tabindex="0" onkeydown={(e) => e.key === "Enter" && (mcpExpanded = mcpExpanded === s.name ? null : s.name)}>
                <span class="sp-mcp-name">{s.name}</span>
                <span class="sp-mcp-right">
                  <button class="sp-io-mini" onclick={(e) => { e.stopPropagation(); exportRawAsset("mcp", s.name); }}>导出 .json</button>
                  <button class="sp-io-mini" onclick={(e) => { e.stopPropagation(); exportAsset("mcp", s.name); }}>导出 .aw</button>
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
      <div class="sp-io-bar"><button class="sp-io-btn" onclick={importAsset}>导入资产（.aw / .md / .json）</button></div>
      {#if pluginList.length === 0}
        <div class="sp-empty">暂无插件（config/plugins/）</div>
      {:else}
        <div class="sp-mcp-list">
          {#each pluginList as p}
            <div class="sp-mcp">
              <div class="sp-mcp-head">
                <span class="sp-mcp-name">{p.name}</span>
                <span class="sp-mcp-right">
                  <button class="sp-io-mini" onclick={(e) => { e.stopPropagation(); exportAsset("plugin", p.name); }}>导出 .aw</button>
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
    {:else if tab === "apps"}
      <AppsPanel />
    {:else if tab === "processes"}
      <ProcessesPanel />
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
    {:else if tab === "config"}
      {#if !configState}
        <div class="sp-empty">配置不可用（需 --server 模式）</div>
      {:else}
        <div class="sp-section">
          <div class="sp-row"><span>版本</span><b>v{configState.appVersion}</b></div>
          <div class="sp-row"><span>当前模型</span><b>{configState.model}</b></div>
          <label class="sp-cfg-row">模型
            <select class="sp-cfg-input" bind:value={cfgModel} onchange={onModelChange}>
              {#each configState.availableModels as m}
                <option value={m.key}>{m.key}（{m.model} · {m.provider}）</option>
              {/each}
            </select>
          </label>
          <label class="sp-cfg-row">温度（0-2，空=默认）
            <input class="sp-cfg-input" bind:value={cfgTemperature} placeholder="默认" />
            <button class="sp-io-mini" onclick={onTemperature}>应用</button>
          </label>
          <label class="sp-cfg-row">max-tokens（≥100，空=默认）
            <input class="sp-cfg-input" bind:value={cfgMaxTokens} placeholder="默认" />
            <button class="sp-io-mini" onclick={onMaxTokens}>应用</button>
          </label>
          <label class="sp-cfg-row">思考展示
            <input type="checkbox" checked={configState.thinking} onchange={onThinking} />
          </label>
          <label class="sp-cfg-row">技能自动沉淀
            <input type="checkbox" checked={configState.skillEvo} onchange={onSkillEvo} />
          </label>
          <div class="sp-cfg-row">
            <button class="sp-io-btn" onclick={onReset}>恢复模型默认（reset）</button>
          </div>
          <div class="sp-cfg-sep">添加模型 / Provider</div>
          <label class="sp-cfg-row">key（唯一标识，如 my-gpt）
            <input class="sp-cfg-input" bind:value={newModelKey} placeholder="如 my-gpt" />
          </label>
          <label class="sp-cfg-row">模型名
            <input class="sp-cfg-input" bind:value={newModelName} placeholder="如 gpt-4o-mini" />
          </label>
          <label class="sp-cfg-row">baseURL
            <input class="sp-cfg-input" bind:value={newModelBase} placeholder="https://api.example.com/v1" />
          </label>
          <label class="sp-cfg-row">provider（可选）
            <input class="sp-cfg-input" bind:value={newModelProvider} placeholder="如 openai / deepseek" />
          </label>
          <label class="sp-cfg-row">apiKey（可选，建议环境变量引用）
            <input class="sp-cfg-input" bind:value={newModelKeyVal} placeholder={'${MY_API_KEY} 或留空继承默认'} />
          </label>
          <div class="sp-cfg-row">
            <button class="sp-io-btn" onclick={onAddModel}>添加模型</button>
          </div>
          {#if cfgMsg}
            <div class="sp-mcp-error">{cfgMsg}</div>
          {/if}
          <div class="sp-note">设置持久化到 data/runtime-config.json 与 config/models.json，重启后仍生效</div>
        </div>
      {/if}
    {:else}
      <div class="sp-io-bar"><button class="sp-io-btn" onclick={importAsset}>导入资产（.aw / .md / .json）</button></div>
      {#if skillList.length === 0}
        <div class="sp-empty">暂无技能</div>
      {:else if detail}
        {@const d = detail}
        <div class="sp-detail">
          <div class="sp-detail-back" onclick={() => (detail = null)}>&#8592; 返回技能列表</div>
          <div class="sp-detail-name">
            {detail.name} <span class="sp-detail-ver">v{detail.version}</span>
            <button class="sp-io-mini sp-io-mini-inline" onclick={() => exportRawAsset("skill", d.name)}>导出 .md</button>
            <button class="sp-io-mini sp-io-mini-inline" onclick={() => exportAsset("skill", d.name)}>导出 .aw</button>
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
        <div class="sp-search-bar">
          <input
            class="sp-search-input"
            bind:value={skillQuery}
            placeholder="检索技能（名称 / 描述 / 专家 / 触发词）..."
          />
        </div>
        {#if filteredGroups.length === 0}
          <div class="sp-empty">无匹配技能</div>
        {:else}
          <div class="sp-groups">
            {#each filteredGroups as [expert, skills]}
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
  .sp-row-ctx { padding: 3px 0; border-bottom: 1px dashed var(--border); }
  .sp-row-ctx-top { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dim); }
  .sp-row-ctx-top span:first-child { flex: 1; }
  .sp-row-ctx-top b { color: var(--text); font-weight: 600; }
  .sp-ctx-pct { color: var(--dim); font-size: 11px; width: 52px; text-align: right; }
  .sp-ctx-bar { height: 4px; border-radius: 2px; background: var(--hover-bg); margin-top: 3px; overflow: hidden; }
  .sp-ctx-fill { display: block; height: 100%; background: var(--primary); border-radius: 2px; }
  .sp-note { font-size: 11px; color: var(--dim); margin-top: 6px; }
  .sp-empty { font-size: 12px; color: var(--dim); padding: 12px 0; text-align: center; }
  .sp-search-bar { padding: 2px 0 8px; }
  .sp-search-input {
    width: 100%;
    padding: 7px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 12px;
    outline: none;
    transition: border-color .15s;
  }
  .sp-search-input:focus { border-color: var(--primary); }
  .sp-groups { display: flex; flex-direction: column; gap: 8px; }
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
  .sp-io-bar { margin-bottom: 8px; display: flex; justify-content: flex-end; gap: 6px; align-items: center; }
  .sp-io-btn { padding: 5px 12px; font-size: 11px; background: var(--primary-light); color: var(--primary); border: none; border-radius: var(--radius-sm); cursor: pointer; font-weight: 600; }
  .sp-chip-active { background: var(--primary); color: var(--panel); }
  /* 审计 Tab：chips 左、计数+刷新图标右；列表铺满弹窗剩余高度 */
  .sp-audit-bar { justify-content: space-between; }
  .sp-audit-chips,
  .sp-audit-right { display: flex; gap: 6px; align-items: center; }
  .sp-io-icon { padding: 4px 6px; background: transparent; color: var(--dim); border: 1px solid transparent; font-weight: 400; }
  .sp-io-icon:hover { color: var(--primary); background: var(--hover-bg); }
  .sp-audit-section { height: 100%; min-height: 0; }
  .sp-audit-count { font-size: 11px; color: var(--dim); }
  .sp-audit-list { display: flex; flex-direction: column; gap: 2px; flex: 1; min-height: 0; overflow: auto; }
  .sp-audit-row { display: flex; align-items: center; gap: 8px; font-size: 11px; padding: 3px 6px; border-radius: 4px; }
  .sp-audit-row:hover { background: var(--hover-bg); }
  .sp-audit-at { color: var(--dim); width: 58px; flex-shrink: 0; }
  .sp-audit-result { width: 14px; flex-shrink: 0; font-weight: 700; }
  .sp-result-success { color: var(--success); }
  .sp-result-blocked { color: var(--warn); }
  .sp-result-error { color: var(--error); }
  .sp-audit-action { color: var(--primary); width: 130px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sp-audit-target { color: var(--text); width: 110px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sp-audit-detail { color: var(--dim); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sp-audit-session { color: var(--dim); width: 60px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sp-dev-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
  .sp-dev-card { border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: var(--panel); display: flex; flex-direction: column; gap: 4px; }
  .sp-dev-head { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--text); flex-wrap: wrap; }
  .sp-dev-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .sp-dev-dot.ok { background: var(--success); }
  .sp-dev-dot.off { background: var(--dim); }
  .sp-dev-engine { font-size: 10px; color: var(--primary); border: 1px solid color-mix(in srgb, var(--primary) 40%, transparent); border-radius: 4px; padding: 0 5px; }
  .sp-dev-badge { font-size: 10px; color: var(--success); border: 1px solid color-mix(in srgb, var(--success) 40%, transparent); border-radius: 4px; padding: 0 5px; }
  .sp-dev-detail { font-size: 11px; color: var(--dim); line-height: 1.5; }
  .sp-dev-note { margin-top: 2px; }
  .sp-dev-btn {
    margin-top: 6px;
    padding: 4px 10px;
    font-size: 11px;
    border: 1px solid color-mix(in srgb, var(--primary) 50%, transparent);
    background: transparent;
    color: var(--primary);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .sp-dev-btn:hover:not(:disabled) { background: var(--primary-light); }
  .sp-dev-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .sp-msg { font-size: 12px; padding: 6px 10px; border-radius: 6px; margin-bottom: 8px; }
  .sp-msg-ok { color: var(--success); background: color-mix(in srgb, var(--success) 10%, transparent); }
  .sp-msg-err { color: var(--error); background: color-mix(in srgb, var(--error) 10%, transparent); }
  .sp-io-btn:hover { filter: brightness(1.05); }
  .sp-io-mini { padding: 1px 8px; font-size: 10px; background: transparent; border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--dim); cursor: pointer; }
  .sp-io-mini:hover { color: var(--primary); border-color: var(--primary); }
  .sp-io-mini-inline { margin-left: 8px; vertical-align: middle; }
  .sp-cfg-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dim); padding: 4px 0; }
  .sp-cfg-input { font-size: 11px; padding: 4px 8px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text); font-family: var(--font-mono); min-width: 120px; }
  .sp-cfg-num { min-width: 80px; width: 80px; }
  .sp-note { font-size: 10px; color: var(--dim); margin-top: 8px; }
  .sp-cfg-sep { font-size: 11px; font-weight: 600; color: var(--dim); border-top: 1px dashed var(--border); padding-top: 10px; margin-top: 10px; }
</style>
