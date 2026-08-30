<script lang="ts">
  /**
   * 智能体管理（Sprint 36「二期」）
   * 内置 7 专家（TS 默认 + YAML 覆盖，可查看/编辑/恢复默认）+ 自定义智能体（GenericAgent）
   * 配置存 config/agents/<id>.yaml，保存即热生效（无需重启）
   */
  import { onMount } from "svelte";
  import { API } from "$lib/stores/chat.svelte";
  import { Plus, RotateCcw, Trash2, Save, Bot, PencilLine } from "lucide-svelte";
  import ConfirmModal from "./ConfirmModal.svelte";

  interface AgentCard {
    id: string;
    name: string;
    displayName: string;
    type: string;
    modelPreference: string;
    maxIterations: number;
    tools: string[];
    skills: string[];
    mcpServers: string[];
    plugins: string[];
    strictTools: boolean;
    permissions: { defaultMode: string; allowedTools: string[]; deniedTools: string[] };
    systemPrompt: string;
    isCustom: boolean;
    hasConfig: boolean;
  }

  interface AgentMeta {
    tools: { name: string; description: string }[];
    skills: { name: string; expert: string; description: string }[];
    mcp: { name: string; connected: boolean; toolCount: number }[];
    plugins: { name: string; tools: string[]; status: string }[];
  }

  let list = $state<AgentCard[]>([]);
  let meta = $state<AgentMeta>({ tools: [], skills: [], mcp: [], plugins: [] });
  let selectedId = $state<string | null>(null);
  let editing = $state<AgentCard | null>(null);
  let isNew = $state(false);
  let saving = $state(false);
  let msg = $state("");
  let err = $state("");
  let confirmDel = $state(false);

  onMount(() => {
    void load();
  });

  const MODELS = ["default", "coding", "reasoning", "writing", "creative", "lite"];

  function freshAgent(): AgentCard {
    return {
      id: "",
      name: "",
      displayName: "",
      type: "custom",
      modelPreference: "default",
      maxIterations: 30,
      tools: [],
      skills: [],
      mcpServers: [],
      plugins: [],
      strictTools: false,
      permissions: { defaultMode: "ask", allowedTools: [], deniedTools: [] },
      systemPrompt: "",
      isCustom: true,
      hasConfig: false,
    };
  }

  async function load() {
    try {
      const [r1, r2] = await Promise.all([
        fetch(`${API}/agents`),
        fetch(`${API}/agents/meta`).catch(() => null),
      ]);
      if (r1.ok) {
        const d = (await r1.json()) as { agents: AgentCard[] };
        list = d.agents || [];
        // 编辑中对象跟随刷新（避免保存后显示旧数据）
        if (editing && !isNew) {
          const cur = list.find((a) => a.id === editing.id);
          if (cur) editing = cloneAgent(cur);
        }
      }
      if (r2?.ok) {
        const m = (await r2.json()) as AgentMeta;
        meta = { tools: m.tools ?? [], skills: m.skills ?? [], mcp: m.mcp ?? [], plugins: m.plugins ?? [] };
      }
    } catch {
      /* 服务离线静默 */
    }
  }

  function cloneAgent(a: AgentCard): AgentCard {
    return {
      ...a,
      tools: [...a.tools],
      skills: [...a.skills],
      mcpServers: [...a.mcpServers],
      plugins: [...a.plugins],
      permissions: { ...a.permissions, allowedTools: [...a.permissions.allowedTools], deniedTools: [...a.permissions.deniedTools] },
    };
  }

  function select(id: string) {
    const a = list.find((x) => x.id === id);
    if (!a) return;
    selectedId = id;
    isNew = false;
    editing = cloneAgent(a);
    msg = "";
    err = "";
  }

  function startNew() {
    selectedId = null;
    isNew = true;
    editing = freshAgent();
    msg = "";
    err = "";
  }

  function toggle(arr: string[], v: string): string[] {
    return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
  }

  async function save() {
    if (!editing) return;
    const a = editing;
    const id = a.id.trim();
    if (!id) {
      err = "请输入 id（小写字母/数字/连字符）";
      return;
    }
    if (!a.displayName.trim()) {
      err = "请输入显示名";
      return;
    }
    if (!a.systemPrompt.trim()) {
      err = "systemPrompt 必填";
      return;
    }
    saving = true;
    err = "";
    try {
      const r = await fetch(`${API}/agents/${encodeURIComponent(id)}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: a.displayName.trim(),
          systemPrompt: a.systemPrompt,
          modelPreference: a.modelPreference,
          maxIterations: a.maxIterations,
          tools: a.tools,
          skills: a.skills,
          mcpServers: a.mcpServers,
          plugins: a.plugins,
          strictTools: a.strictTools,
          permissions: { defaultMode: a.permissions.defaultMode, allowedTools: a.permissions.allowedTools, deniedTools: a.permissions.deniedTools },
        }),
      });
      const d = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !d.ok) {
        err = d.error ?? "保存失败";
        return;
      }
      msg = isNew ? `已创建智能体「${a.displayName}」并生效` : `已保存并热生效（无需重启）`;
      isNew = false;
      selectedId = id;
      await load();
    } catch (e) {
      err = (e as Error).message;
    } finally {
      saving = false;
    }
  }

  async function reset() {
    if (!editing) return;
    const id = editing.id;
    err = "";
    try {
      const r = await fetch(`${API}/agents/${encodeURIComponent(id)}/reset`, { method: "POST" });
      const d = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !d.ok) {
        err = d.error ?? "恢复失败";
        return;
      }
      msg = "已恢复内置默认配置";
      await load();
      select(id);
    } catch (e) {
      err = (e as Error).message;
    }
  }

  async function del() {
    if (!editing) return;
    const id = editing.id;
    confirmDel = false;
    try {
      const r = await fetch(`${API}/agents/${encodeURIComponent(id)}/delete`, { method: "POST" });
      const d = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !d.ok) {
        err = d.error ?? "删除失败";
        return;
      }
      msg = `已删除智能体 ${id}`;
      editing = null;
      selectedId = null;
      await load();
    } catch (e) {
      err = (e as Error).message;
    }
  }

  /** 声明自动展开的工具（mcp_<server>_ 前缀 / 插件工具），只读展示 */
  function expandedTools(a: AgentCard): string[] {
    const set = new Set<string>();
    for (const s of a.mcpServers) set.add(`mcp_${s}_*`);
    for (const p of a.plugins) {
      const pl = meta.plugins.find((x) => x.name === p);
      for (const t of pl?.tools ?? []) set.add(`${p}:${t}`);
    }
    return [...set];
  }
</script>

<div class="ap">
  <div class="ap-head">
    <span class="ap-title"><Bot size={14} /> 智能体</span>
    <button class="ap-new" onclick={startNew}><Plus size={12} /> 新建智能体</button>
  </div>

  <div class="ap-body">
    <!-- 左：列表 -->
    <div class="ap-list">
      {#each list as a (a.id)}
        <div class="ap-item" class:active={a.id === selectedId} onclick={() => select(a.id)}>
          <div class="ap-item-name">
            {a.displayName || a.id}
            {#if a.isCustom}
              <span class="ap-badge custom">自定义</span>
            {:else if a.hasConfig}
              <span class="ap-badge">已覆盖</span>
            {/if}
          </div>
          <div class="ap-item-meta">{a.id} · {a.modelPreference} · {a.maxIterations} 轮</div>
        </div>
      {/each}
      {#if list.length === 0}
        <div class="ap-empty">暂无智能体</div>
      {/if}
    </div>

    <!-- 右：详情/编辑 -->
    <div class="ap-detail">
      {#if editing}
        <div class="ap-form">
          <div class="ap-row">
            <label class="ap-label">id</label>
            <input
              class="ap-input"
              bind:value={editing.id}
              placeholder="如 my-agent（小写字母/数字/连字符）"
              disabled={!isNew}
            />
          </div>
          <div class="ap-row">
            <label class="ap-label">显示名</label>
            <input class="ap-input" bind:value={editing.displayName} placeholder="如 数据分析师" />
          </div>
          <div class="ap-row">
            <label class="ap-label">模型偏好</label>
            <select class="ap-input ap-select" bind:value={editing.modelPreference}>
              {#each MODELS as m}
                <option value={m}>{m}</option>
              {/each}
            </select>
          </div>
          <div class="ap-row">
            <label class="ap-label">迭代上限</label>
            <input class="ap-input" type="number" min="1" max="200" bind:value={editing.maxIterations} />
          </div>
          <div class="ap-row">
            <label class="ap-label">默认权限</label>
            <select class="ap-input ap-select" bind:value={editing.permissions.defaultMode}>
              <option value="ask">Ask（只读问答）</option>
              <option value="plan">Plan（每步确认）</option>
              <option value="auto">Auto（自动执行）</option>
            </select>
          </div>
          <div class="ap-row ap-row-inline">
            <label class="ap-label">严格工具模式</label>
            <label class="ap-check">
              <input type="checkbox" bind:checked={editing.strictTools} />
              关闭 mcp/插件工具全局豁免，仅白名单可见
            </label>
          </div>

          <div class="ap-row">
            <label class="ap-label">System Prompt <span class="ap-hint">（{editing.systemPrompt.length} 字符）</span></label>
            <textarea class="ap-textarea" bind:value={editing.systemPrompt} rows={9}></textarea>
          </div>

          <div class="ap-row">
            <label class="ap-label">工具（白名单）</label>
            <div class="ap-chips">
              {#each meta.tools as t (t.name)}
                <label class="ap-chip">
                  <input type="checkbox" checked={editing.tools.includes(t.name)} onchange={() => (editing.tools = toggle(editing.tools, t.name))} />
                  {t.name}
                </label>
              {/each}
              {#if expandedTools(editing).length > 0}
                <div class="ap-auto">自动包含：{#each expandedTools(editing) as t (t)}{t}{#if t !== expandedTools(editing).at(-1)}、{/if}{/each}</div>
              {/if}
            </div>
          </div>

          <div class="ap-row">
            <label class="ap-label">绑定技能</label>
            <div class="ap-chips">
              {#if meta.skills.length === 0}
                <span class="ap-hint">暂无技能（skills/ 目录加载）</span>
              {/if}
              {#each meta.skills as s (s.name)}
                <label class="ap-chip" title={s.description}>
                  <input type="checkbox" checked={editing.skills.includes(s.name)} onchange={() => (editing.skills = toggle(editing.skills, s.name))} />
                  {s.name}{#if s.expert}<span class="ap-chip-expert">({s.expert})</span>{/if}
                </label>
              {/each}
            </div>
          </div>

          <div class="ap-row">
            <label class="ap-label">绑定 MCP</label>
            <div class="ap-chips">
              {#if meta.mcp.length === 0}
                <span class="ap-hint">暂无 MCP 服务器</span>
              {/if}
              {#each meta.mcp as m (m.name)}
                <label class="ap-chip">
                  <input type="checkbox" checked={editing.mcpServers.includes(m.name)} onchange={() => (editing.mcpServers = toggle(editing.mcpServers, m.name))} />
                  {m.name}{#if !m.connected}<span class="ap-chip-expert">(未连接)</span>{/if}
                </label>
              {/each}
            </div>
          </div>

          <div class="ap-row">
            <label class="ap-label">绑定插件</label>
            <div class="ap-chips">
              {#if meta.plugins.length === 0}
                <span class="ap-hint">暂无插件</span>
              {/if}
              {#each meta.plugins as p (p.name)}
                <label class="ap-chip">
                  <input type="checkbox" checked={editing.plugins.includes(p.name)} onchange={() => (editing.plugins = toggle(editing.plugins, p.name))} />
                  {p.name}{#if p.tools.length > 0}<span class="ap-chip-expert">({p.tools.length} 工具)</span>{/if}
                </label>
              {/each}
            </div>
          </div>

          {#if msg}<div class="ap-msg">{msg}</div>{/if}
          {#if err}<div class="ap-err">{err}</div>{/if}

          <div class="ap-actions">
            <button class="ap-btn primary" onclick={() => void save()} disabled={saving}>
              <Save size={12} /> {isNew ? "创建" : "保存并生效"}
            </button>
            {#if !isNew && !editing.isCustom}
              <button class="ap-btn" onclick={() => void reset()} title="删除 YAML 覆盖，恢复 TS 内置默认">
                <RotateCcw size={12} /> 恢复默认
              </button>
            {/if}
            {#if !isNew && editing.isCustom}
              <button class="ap-btn danger" onclick={() => (confirmDel = true)}>
                <Trash2 size={12} /> 删除
              </button>
            {/if}
          </div>
        </div>
      {:else}
        <div class="ap-empty-detail">
          <PencilLine size={20} />
          <p>选择左侧智能体查看/编辑 Prompt 配置</p>
          <p class="ap-hint">或点击「新建智能体」创建自定义专家（支持绑定技能 / MCP / 插件）</p>
        </div>
      {/if}
    </div>
  </div>
</div>

{#if confirmDel && editing}
  <ConfirmModal
    title="删除智能体"
    message={`确定删除自定义智能体「${editing.displayName}」（${editing.id}）？将移除其 YAML 配置。`}
    confirmText="删除"
    danger
    onConfirm={() => void del()}
    onCancel={() => (confirmDel = false)}
  />
{/if}

<style>
  .ap { height: 100%; display: flex; flex-direction: column; min-height: 0; }
  .ap-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 4px 0 10px; border-bottom: 1px solid var(--border);
  }
  .ap-title { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 6px; color: var(--text); }
  .ap-new {
    display: flex; align-items: center; gap: 4px;
    padding: 5px 12px; border: 1px solid var(--primary); border-radius: var(--radius-sm);
    background: transparent; color: var(--primary); font-size: 12px; cursor: pointer;
  }
  .ap-new:hover { background: var(--primary); color: #fff; }
  .ap-body { flex: 1; min-height: 0; display: flex; gap: 14px; padding-top: 10px; }
  .ap-list { width: 220px; flex-shrink: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
  .ap-item { padding: 8px 10px; border-radius: var(--radius-sm); cursor: pointer; border: 1px solid transparent; }
  .ap-item:hover { background: var(--hover-bg); }
  .ap-item.active { background: var(--primary-light); border-color: rgba(75, 117, 238, .2); }
  .ap-item-name { font-size: 12px; font-weight: 600; color: var(--text); display: flex; align-items: center; gap: 6px; }
  .ap-item-meta { font-size: 11px; color: var(--dim); margin-top: 2px; }
  .ap-badge {
    font-size: 10px; font-weight: 600; color: var(--primary);
    background: var(--primary-light); border-radius: 8px; padding: 0 6px;
  }
  .ap-badge.custom { color: var(--success); background: rgba(46, 194, 126, .12); }
  .ap-empty { font-size: 12px; color: var(--dim); padding: 20px; text-align: center; }
  .ap-detail { flex: 1; min-width: 0; overflow-y: auto; }
  .ap-form { display: flex; flex-direction: column; gap: 10px; }
  .ap-row { display: flex; flex-direction: column; gap: 4px; }
  .ap-row-inline { flex-direction: row; align-items: center; gap: 10px; }
  .ap-label { font-size: 11px; font-weight: 600; color: var(--dim); }
  .ap-hint { font-size: 11px; color: var(--dim); font-weight: 400; }
  .ap-input {
    padding: 7px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--bg); color: var(--text); font-family: var(--font-ui); font-size: 12px;
  }
  .ap-input:focus { outline: none; border-color: var(--primary); }
  .ap-select { cursor: pointer; }
  .ap-textarea {
    width: 100%; min-height: 150px; resize: vertical;
    padding: 9px 11px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--bg); color: var(--text); font-family: var(--font-mono, monospace);
    font-size: 12px; line-height: 1.6;
  }
  .ap-textarea:focus { outline: none; border-color: var(--primary); }
  .ap-chips { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
  .ap-chip {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 8px; border: 1px solid var(--border); border-radius: 12px;
    font-size: 11px; color: var(--text); cursor: pointer; background: var(--surface);
  }
  .ap-chip:hover { border-color: var(--primary); }
  .ap-chip-expert { color: var(--dim); font-size: 10px; }
  .ap-auto { font-size: 11px; color: var(--primary); width: 100%; }
  .ap-msg { font-size: 12px; color: var(--success); padding: 6px 10px; background: rgba(46, 194, 126, .08); border-radius: var(--radius-sm); }
  .ap-err { font-size: 12px; color: var(--error); padding: 6px 10px; background: rgba(232, 84, 107, .08); border-radius: var(--radius-sm); }
  .ap-actions { display: flex; gap: 8px; margin-top: 4px; }
  .ap-btn {
    display: flex; align-items: center; gap: 5px;
    padding: 6px 14px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: transparent; color: var(--dim); font-size: 12px; cursor: pointer;
  }
  .ap-btn:hover { border-color: var(--primary); color: var(--primary); }
  .ap-btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; font-weight: 600; }
  .ap-btn.primary:hover { background: var(--primary-hover); }
  .ap-btn.danger:hover { border-color: var(--error); color: var(--error); }
  .ap-check { font-size: 11px; color: var(--dim); display: flex; align-items: center; gap: 5px; cursor: pointer; }
  .ap-empty-detail {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    height: 100%; color: var(--dim); gap: 8px; text-align: center;
  }
</style>
