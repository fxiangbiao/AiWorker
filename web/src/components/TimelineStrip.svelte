<script lang="ts">
  /**
   * 检查点时间线（Sprint 50）— 由右栏「回滚」独立面板降级而来：
   * 回滚是**时间轴上的操作**，不再与"文档/文件变更"平级。
   * 「仅对话」回滚不在这里（已移到对话流用户消息的「从这里重新开始」）。
   * dry-run 预览、冲突强制开关、二次确认与旧面板等价。
   */
  import { API, store, loadRemoteMessages, saveMessages } from "$lib/stores/chat.svelte";
  import type { TimelineTurn } from "$lib/artifacts";
  import ConfirmModal from "./ConfirmModal.svelte";
  import { AlertTriangle } from "lucide-svelte";

  type Scope = "all" | "code";

  interface PlanFile {
    path: string;
    action: "restore" | "delete" | "skip" | "conflict";
    reason?: string;
  }
  interface Plan {
    toTurn: number;
    scope: Scope;
    turns: number[];
    files: PlanFile[];
    messageCount: number;
    blockers: string[];
  }
  interface ApplyResult {
    restored: string[];
    deleted: string[];
    skipped: { path: string; reason: string }[];
    conflicts: string[];
    messagesDeleted: number;
    toTurn: number;
    scope: Scope;
  }

  let {
    timeline,
    onApplied,
    selectedTurn = $bindable<number | null>(null),
  }: {
    timeline: TimelineTurn[];
    onApplied?: () => void;
    selectedTurn?: number | null;
  } = $props();

  const SCOPE_LABEL: Record<Scope, string> = { all: "代码 + 对话", code: "仅代码" };

  let scope = $state<Scope>("code");
  let plan = $state<Plan | null>(null);
  let planLoading = $state(false);
  let pendingScope = $state<Scope | null>(null);
  let applying = $state(false);
  let force = $state(false);
  let error = $state("");
  let result = $state<ApplyResult | null>(null);

  function sessionId(): string {
    return store.activeChatId ?? "";
  }

  function shortPath(p: string): string {
    const parts = p.replace(/\\/g, "/").split("/");
    return parts.length <= 2 ? p : `…/${parts.slice(-2).join("/")}`;
  }

  async function preview(turn: number): Promise<void> {
    const id = sessionId();
    if (!id) return;
    selectedTurn = turn;
    planLoading = true;
    result = null;
    error = "";
    try {
      const resp = await fetch(`${API}/sessions/${encodeURIComponent(id)}/rewind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toTurn: turn, scope, dryRun: true }),
      });
      plan = resp.ok ? ((await resp.json()) as { plan: Plan }).plan : null;
      if (!resp.ok) error = `预览失败（${resp.status}）`;
    } catch {
      plan = null;
      error = "无法连接服务端";
    } finally {
      planLoading = false;
    }
  }

  async function changeScope(next: Scope): Promise<void> {
    scope = next;
    if (selectedTurn !== null) await preview(selectedTurn);
  }

  async function apply(chosen: Scope): Promise<void> {
    const id = sessionId();
    if (!id || selectedTurn === null) return;
    pendingScope = null;
    applying = true;
    error = "";
    try {
      const resp = await fetch(`${API}/sessions/${encodeURIComponent(id)}/rewind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toTurn: selectedTurn, scope: chosen, force }),
      });
      const data = (await resp.json()) as { ok?: boolean; result?: ApplyResult; error?: string };
      if (!resp.ok || !data.ok || !data.result) {
        error = data.error ?? `回滚失败（${resp.status}）`;
        return;
      }
      result = data.result;
      if (data.result.messagesDeleted > 0 || chosen !== "code") {
        saveMessages(id, []);
        const msgs = await loadRemoteMessages(id);
        if (store.activeChatId === id) {
          store.messages.length = 0;
          store.messages.push(...msgs);
        }
      }
      force = false;
      await preview(selectedTurn);
      onApplied?.();
    } catch {
      error = "无法连接服务端";
    } finally {
      applying = false;
    }
  }
</script>

<div class="tl">
  <div class="tl-head">
    <span class="tl-title">时间线</span>
    <select
      class="tl-scope"
      value={scope}
      title="回滚范围（默认仅代码：危险面最小）"
      onchange={(e) => void changeScope((e.target as HTMLSelectElement).value as Scope)}
    >
      {#each Object.entries(SCOPE_LABEL) as [value, label] (value)}
        <option {value}>{label}</option>
      {/each}
    </select>
    {#if selectedTurn !== null}
      <button class="tl-clear" onclick={() => { selectedTurn = null; plan = null; result = null; }}>取消选择</button>
    {/if}
  </div>

  {#if timeline.length === 0}
    <div class="tl-empty">本会话暂无检查点（检查点在每轮对话开始时创建，保留最近 20 轮）</div>
  {:else}
    <div class="tl-track">
      {#each timeline as t (t.turn)}
        <button
          class="tl-node"
          class:active={selectedTurn === t.turn}
          title={`第 ${t.turn} 轮 · ${t.userInput ?? "(无输入摘要)"} · ${new Date(t.createdAt).toLocaleString()}`}
          onclick={() => void preview(t.turn)}
        >
          <span class="tl-dot"></span>
          <span class="tl-no">{t.turn}</span>
          <span class="tl-badge">{t.files.filter((f) => f.restorable).length} 可恢复</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if error}<div class="tl-error">{error}</div>{/if}

  {#if planLoading}
    <div class="tl-empty">正在生成预览…</div>
  {:else if plan}
    {#if plan.blockers.length > 0}
      <div class="tl-error">{plan.blockers[0]}</div>
    {:else}
      <div class="tl-plan">
        <div class="tl-plan-head">
          回到第 {plan.toTurn} 轮之前 · 撤销回合 {plan.turns.join(", ")}
          {#if plan.scope === "all"}· 同时移除 {plan.messageCount} 条消息{/if}
        </div>
        {#if plan.files.length === 0}
          <div class="tl-dim">{plan.scope === "code" ? "该轮没有可回滚的文件改动" : "无文件改动"}</div>
        {:else}
          <div class="tl-files">
            {#each plan.files as f (f.path)}
              <div class="tl-file" class:restore={f.action === "restore"} class:del={f.action === "delete"} class:warn={f.action === "conflict"} class:skip={f.action === "skip"}>
                <span class="tl-act">{f.action === "restore" ? "还原" : f.action === "delete" ? "删除" : f.action === "conflict" ? "冲突" : "跳过"}</span>
                <span class="tl-path" title={f.path}>{shortPath(f.path)}</span>
              </div>
            {/each}
          </div>
        {/if}
        {#if plan.files.some((f) => f.action === "conflict")}
          <label class="tl-force"><input type="checkbox" bind:checked={force} /> 强制覆盖有外部改动的文件</label>
        {/if}
        <div class="tl-actions">
          <button class="tl-btn danger" disabled={applying} onclick={() => (pendingScope = "code")}>回滚代码</button>
          <button class="tl-btn" disabled={applying} onclick={() => (pendingScope = "all")}>回滚代码 + 对话</button>
        </div>
        <div class="tl-hint">
          <AlertTriangle size={11} />
          terminal_exec 的改动不可回滚（列为「跳过」）；回滚不删历史事件，轨迹仍可查；「仅对话」在对话流消息上操作
        </div>
      </div>
    {/if}
  {/if}

  {#if result}
    <div class="tl-result">
      ✓ 已回滚到第 {result.toTurn} 轮之前（{SCOPE_LABEL[result.scope]}）：还原 {result.restored.length} 文件{result.deleted.length > 0
        ? ` · 删除 ${result.deleted.length} 个新建文件`
        : ""}{result.messagesDeleted > 0 ? ` · 移除 ${result.messagesDeleted} 条消息` : ""}
      {#if result.conflicts.length > 0}
        <div class="tl-warn">跳过 {result.conflicts.length} 个有外部改动的文件（勾选强制覆盖后重试）</div>
      {/if}
    </div>
  {/if}
</div>

{#if pendingScope}
  <ConfirmModal
    title="确认回滚"
    danger
    confirmText="确认回滚"
    message={`回到第 ${selectedTurn} 轮之前（${SCOPE_LABEL[pendingScope]}）？将撤销回合 ${plan?.turns.join(", ") ?? ""}${pendingScope === "all" ? `，并移除 ${plan?.messageCount ?? 0} 条消息` : ""}。此操作不可撤销。`}
    onConfirm={() => void apply(pendingScope as Scope)}
    onCancel={() => (pendingScope = null)}
  />
{/if}

<style>
  .tl { border-top: 1px solid var(--border); padding-top: 8px; display: flex; flex-direction: column; gap: 6px; flex: 0 0 auto; }
  .tl-head { display: flex; align-items: center; gap: 8px; }
  .tl-title { font-size: 11px; font-weight: 600; color: var(--text); }
  .tl-scope {
    font-size: 11px;
    background: var(--panel);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 1px 4px;
  }
  .tl-clear { margin-left: auto; font-size: 10px; color: var(--dim); background: none; border: none; cursor: pointer; }
  .tl-empty, .tl-dim { font-size: 11px; color: var(--dim); }
  .tl-track { display: flex; align-items: center; gap: 4px; overflow-x: auto; padding: 2px 0; }
  .tl-node {
    display: flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    padding: 2px 6px;
    cursor: pointer;
    color: var(--dim);
    font-size: 10px;
    white-space: nowrap;
  }
  .tl-node:hover { background: var(--hover-bg); }
  .tl-node.active { border-color: var(--primary); color: var(--primary); background: var(--primary-light); }
  .tl-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .tl-no { font-weight: 600; }
  .tl-badge { font-size: 9px; opacity: 0.75; }
  .tl-error { font-size: 11px; color: var(--danger); }
  .tl-plan { display: flex; flex-direction: column; gap: 5px; }
  .tl-plan-head { font-size: 11px; color: var(--text); }
  .tl-files { display: flex; flex-direction: column; gap: 2px; max-height: 22vh; overflow: auto; }
  .tl-file { display: flex; gap: 6px; font-size: 11px; }
  .tl-act { flex: 0 0 34px; color: var(--dim); }
  .tl-file.restore .tl-act { color: var(--success); }
  .tl-file.del .tl-act { color: var(--danger); }
  .tl-file.warn .tl-act { color: var(--warning, #d29922); }
  .tl-path { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tl-force { font-size: 11px; color: var(--dim); display: flex; align-items: center; gap: 4px; }
  .tl-actions { display: flex; gap: 6px; }
  .tl-btn {
    font-size: 11px;
    padding: 3px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--panel);
    color: var(--text);
    cursor: pointer;
  }
  .tl-btn.danger { border-color: color-mix(in srgb, var(--danger) 45%, transparent); color: var(--danger); }
  .tl-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .tl-hint { display: flex; align-items: flex-start; gap: 4px; font-size: 10px; color: var(--dim); line-height: 1.5; }
  .tl-result { font-size: 11px; color: var(--success); }
  .tl-warn { color: var(--warning, #d29922); }
</style>
