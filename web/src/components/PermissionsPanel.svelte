<script lang="ts">
  import { API } from "$lib/stores/chat.svelte";
  import { RefreshCw, ShieldCheck, Trash2, Plus, AlertTriangle } from "lucide-svelte";

  const TOKEN = typeof window !== "undefined" ? (window.__AIWORKER_TOKEN__ ?? "") : "";

  type RuleAction = "allow" | "ask" | "deny";
  type RuleSource = "project" | "session";

  interface Rule {
    tool: string;
    match?: string;
    action: RuleAction;
    source: RuleSource;
  }

  let loading = $state(false);
  let error = $state("");
  let notice = $state("");
  let rules = $state<Rule[]>([]);
  let configPath = $state("");

  let draftAction = $state<RuleAction>("allow");
  let draftTool = $state("");
  let draftMatch = $state("");
  let draftScope = $state<RuleSource>("project");
  let adding = $state(false);
  let busy = $state(false);

  const ACTION_LABEL: Record<RuleAction, string> = { allow: "允许", ask: "询问", deny: "拒绝" };

  async function load(): Promise<void> {
    loading = true;
    error = "";
    try {
      const resp = await fetch(`${API}/permissions`);
      if (!resp.ok) {
        error = resp.status === 503 ? "服务端未启用权限记忆" : `加载失败（${resp.status}）`;
        rules = [];
        return;
      }
      const data = (await resp.json()) as { rules: Rule[]; configPath: string };
      rules = data.rules ?? [];
      configPath = data.configPath ?? "";
    } catch {
      error = "无法连接服务端";
      rules = [];
    } finally {
      loading = false;
    }
  }

  async function submit(body: Record<string, unknown>): Promise<boolean> {
    error = "";
    notice = "";
    try {
      const resp = await fetch(`${API}/permissions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-aiworker-token": TOKEN },
        body: JSON.stringify(body),
      });
      const data = (await resp.json()) as { error?: string; rules?: Rule[]; configPath?: string; warning?: string };
      if (!resp.ok) {
        error = data.error ?? `操作失败（${resp.status}）`;
        if (data.rules) rules = data.rules;
        return false;
      }
      rules = data.rules ?? rules;
      if (data.configPath) configPath = data.configPath;
      if (data.warning) notice = data.warning;
      return true;
    } catch {
      error = "无法连接服务端";
      return false;
    }
  }

  async function addRule(): Promise<void> {
    const tool = draftTool.trim();
    if (!tool) {
      error = "请填写工具名（支持通配，如 fs_*）";
      return;
    }
    adding = true;
    const ok = await submit({
      action: "add",
      tool,
      match: draftMatch.trim() || undefined,
      ruleAction: draftAction,
      scope: draftScope,
    });
    adding = false;
    if (ok) {
      notice = `已写入${draftScope === "project" ? "项目级" : "会话级"}规则`;
      draftTool = "";
      draftMatch = "";
    }
  }

  async function revoke(rule: Rule): Promise<void> {
    if (busy) return;
    busy = true;
    const ok = await submit({
      action: "revoke",
      tool: rule.tool,
      match: rule.match,
      ruleAction: rule.action,
      scope: rule.source,
    });
    busy = false;
    if (ok) notice = "已撤销规则";
  }

  async function resetProject(): Promise<void> {
    if (busy) return;
    busy = true;
    if (await submit({ action: "reset" })) notice = "已清空项目级规则";
    busy = false;
  }

  async function clearSession(): Promise<void> {
    if (busy) return;
    busy = true;
    if (await submit({ action: "clear-session" })) notice = "已清空会话级规则";
    busy = false;
  }

  /** 规则身份（去重后唯一）；用稳定 key 而不是索引，避免列表变动时 DOM 错位 */
  function ruleKey(r: Rule): string {
    return `${r.source}|${r.action}|${r.tool}|${r.match ?? ""}`;
  }

  $effect(() => {
    void load();
  });
</script>

<div class="perms">
  <div class="head">
    <span class="title"><ShieldCheck size={14} /> 权限规则</span>
    <button class="icon-btn" title="刷新" onclick={() => void load()} disabled={loading}>
      <span class="ico" class:spin={loading}><RefreshCw size={13} /></span>
    </button>
  </div>
  {#if configPath}
    <div class="path-line" title={configPath}>项目配置：{configPath}</div>
  {/if}

  <div class="form">
    <select bind:value={draftAction}>
      <option value="allow">允许</option>
      <option value="ask">询问</option>
      <option value="deny">拒绝</option>
    </select>
    <input placeholder="工具（如 fs_write / fs_*）" bind:value={draftTool} />
    <input placeholder="目标 glob（可空，如 *notes*）" bind:value={draftMatch} />
    <select bind:value={draftScope}>
      <option value="project">项目级（写文件）</option>
      <option value="session">本会话</option>
    </select>
    <button class="btn" disabled={adding} onclick={() => void addRule()}><Plus size={12} /> 添加</button>
  </div>

  {#if rules.length === 0}
    <div class="empty">暂无规则<br /><span class="dim">全部按权限模式与工具白名单判定；确认弹窗里的「始终允许」也会出现在这里</span></div>
  {:else}
    <div class="list">
      {#each rules as r (ruleKey(r))}
        <div class="rule">
          <span class="act" class:allow={r.action === "allow"} class:ask={r.action === "ask"} class:deny={r.action === "deny"}>
            {ACTION_LABEL[r.action]}
          </span>
          <span class="tool" title={r.tool}>{r.tool}</span>
          <span class="match" title={r.match ?? "*"}>{r.match ?? "*"}</span>
          <span class="src" class:session={r.source === "session"}>{r.source === "project" ? "项目" : "会话"}</span>
          <button class="icon-btn" title="撤销该规则" disabled={busy} onclick={() => void revoke(r)}><Trash2 size={12} /></button>
        </div>
      {/each}
    </div>
  {/if}

  {#if notice}
    <div class="ok">{notice}</div>
  {/if}
  {#if error}
    <div class="error">{error}</div>
  {/if}

  <div class="actions">
    <button class="btn" disabled={busy} onclick={() => void resetProject()}>清空项目级</button>
    <button class="btn" disabled={busy} onclick={() => void clearSession()}>清空会话级</button>
  </div>

  <div class="hint">
    <AlertTriangle size={12} />
    优先级 deny &gt; ask &gt; allow；allow 不得覆盖永不自动批准清单与受保护路径（写入时即拒绝）；会话级规则重启后失效
  </div>
</div>

<style>
  /*
   * Sprint 50 / IA 重构：本面板从「右栏 Tab」改为「设置 → 安全」里的一个 section。
   * 因此**不再自带高度与滚动**（原先 `height:100% + overflow-y:auto` 会与外层设置面板形成双层滚动，
   * 这正是上一轮用户反馈过的问题）；滚动交给设置面板唯一的滚动容器。
   */
  .perms { display: flex; flex-direction: column; font-size: 12px; }
  .head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 0; border-bottom: 1px solid var(--border);
    background: var(--surface); z-index: 1;
  }
  .title { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
  .icon-btn {
    background: transparent; border: 1px solid var(--border); border-radius: var(--radius-sm);
    color: var(--dim); padding: 3px 6px; cursor: pointer; display: inline-flex; align-items: center;
  }
  .icon-btn:hover { color: var(--text); background: var(--hover-bg); }
  .ico { display: inline-flex; align-items: center; }
  .ico.spin :global(svg) { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .path-line { color: var(--dim); font-size: 11px; padding: 8px 12px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .form { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
  .form input, .form select {
    background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm);
    color: var(--text); font-size: 12px; padding: 4px 6px; min-width: 0;
  }
  .form input { flex: 1 1 130px; }
  .empty, .error, .dim, .hint, .ok { color: var(--dim); padding: 12px; line-height: 1.6; }
  .error { color: var(--error); }
  .ok { color: var(--primary); padding: 8px 12px 0; }
  .list { display: flex; flex-direction: column; }
  .rule {
    display: flex; align-items: center; gap: 6px; padding: 6px 12px;
    border-bottom: 1px solid var(--border);
  }
  .rule:hover { background: var(--hover-bg); }
  .act { flex: 0 0 auto; font-size: 11px; padding: 1px 5px; border-radius: 4px; background: var(--hover-bg); color: var(--dim); }
  .act.allow { color: var(--primary); }
  .act.ask { color: #d97706; }
  .act.deny { color: var(--error); }
  .tool { flex: 0 0 auto; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .match { flex: 1 1 auto; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .src { flex: 0 0 auto; font-size: 11px; color: var(--dim); }
  .src.session { color: #d97706; }
  .actions { display: flex; gap: 6px; padding: 10px 12px; }
  .btn {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 6px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface); color: var(--text); font-size: 12px; cursor: pointer;
  }
  .btn:hover { background: var(--hover-bg); }
  .btn:disabled { opacity: .5; cursor: default; }
  .hint { display: flex; align-items: flex-start; gap: 6px; padding: 0 12px 12px; font-size: 11px; }
</style>
