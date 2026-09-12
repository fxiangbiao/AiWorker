<script lang="ts">
  import { API, store, loadRemoteMessages, saveMessages } from "$lib/stores/chat.svelte";
  import ConfirmModal from "./ConfirmModal.svelte";
  import { RotateCcw, RefreshCw, AlertTriangle } from "lucide-svelte";

  type Scope = "all" | "chat" | "code";

  interface TurnFile {
    path: string;
    restorable: boolean;
    reason?: string;
    existedBefore: boolean;
    tool: string;
    added?: number;
    removed?: number;
  }
  interface Turn {
    turn: number;
    createdAt: number;
    userInput?: string;
    files: TurnFile[];
  }
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

  const SCOPE_LABEL: Record<Scope, string> = { all: "代码 + 对话", chat: "仅对话", code: "仅代码" };

  let loading = $state(false);
  let error = $state("");
  let turns = $state<Turn[]>([]);
  let selected = $state<number | null>(null);
  let plan = $state<Plan | null>(null);
  let planLoading = $state(false);
  let pendingScope = $state<Scope | null>(null);
  let applying = $state(false);
  let result = $state<ApplyResult | null>(null);
  let force = $state(false);

  function sessionId(): string {
    return store.activeChatId ?? "";
  }

  function shortPath(p: string): string {
    const parts = p.replace(/\\/g, "/").split("/");
    return parts.length <= 2 ? p : `…/${parts.slice(-2).join("/")}`;
  }

  async function loadTurns(): Promise<void> {
    const id = sessionId();
    if (!id) {
      turns = [];
      return;
    }
    loading = true;
    error = "";
    try {
      const resp = await fetch(`${API}/sessions/${encodeURIComponent(id)}/checkpoints`);
      if (!resp.ok) {
        error = resp.status === 503 ? "服务端未启用检查点服务" : `加载失败（${resp.status}）`;
        turns = [];
        return;
      }
      const data = (await resp.json()) as { turns: Turn[] };
      turns = data.turns ?? [];
      if (selected !== null && !turns.some((t) => t.turn === selected)) {
        selected = null;
        plan = null;
      }
    } catch {
      error = "无法连接服务端";
      turns = [];
    } finally {
      loading = false;
    }
  }

  async function preview(turn: number): Promise<void> {
    const id = sessionId();
    if (!id) return;
    selected = turn;
    planLoading = true;
    result = null;
    try {
      const resp = await fetch(`${API}/sessions/${encodeURIComponent(id)}/rewind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toTurn: turn, scope: "all", dryRun: true }),
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

  async function apply(scope: Scope): Promise<void> {
    const id = sessionId();
    if (!id) return;
    pendingScope = null;
    applying = true;
    error = "";
    try {
      const resp = await fetch(`${API}/sessions/${encodeURIComponent(id)}/rewind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toTurn: selected, scope, force }),
      });
      const data = (await resp.json()) as { ok?: boolean; result?: ApplyResult; error?: string };
      if (!resp.ok || !data.ok || !data.result) {
        error = data.error ?? `回滚失败（${resp.status}）`;
        return;
      }
      result = data.result;
      if (data.result.messagesDeleted > 0 || scope !== "code") {
        // 对话回滚后本地缓存已过期：丢弃并重新拉取服务端投影
        saveMessages(id, []);
        const msgs = await loadRemoteMessages(id);
        if (store.activeChatId === id) {
          store.messages.length = 0;
          store.messages.push(...msgs);
        }
      }
      force = false;
      await loadTurns();
      if (selected !== null) await preview(selected);
    } catch {
      error = "无法连接服务端";
    } finally {
      applying = false;
    }
  }

  $effect(() => {
    const id = store.activeChatId;
    selected = null;
    plan = null;
    result = null;
    if (id) void loadTurns();
  });
</script>

<div class="rewind">
  <div class="head">
    <span class="title"><RotateCcw size={14} /> 检查点回滚</span>
    <button class="icon-btn" title="刷新" onclick={() => void loadTurns()} disabled={loading}>
      <span class="ico" class:spin={loading}><RefreshCw size={13} /></span>
    </button>
  </div>

  {#if !sessionId()}
    <div class="empty">当前没有选中的会话（检查点在每轮对话开始时创建）</div>
  {:else if turns.length === 0}
    <div class="empty">本会话暂无检查点<br /><span class="dim">检查点保留最近 20 轮；仅 fs 工具写入可精确回滚</span></div>
  {:else}
    <div class="list">
      {#each turns as t (t.turn)}
        <button class="turn" class:active={selected === t.turn} onclick={() => void preview(t.turn)}>
          <span class="turn-no">第 {t.turn} 轮</span>
          <span class="turn-input" title={t.userInput ?? ""}>{t.userInput ?? "(无输入摘要)"}</span>
          <span class="turn-meta">
            {new Date(t.createdAt).toLocaleTimeString()}
            · {t.files.filter((f) => f.restorable).length}/{t.files.length} 可恢复
          </span>
        </button>
      {/each}
    </div>
  {/if}

  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if planLoading}
    <div class="empty">正在生成预览…</div>
  {:else if plan}
    {#if plan.blockers.length > 0}
      <div class="error">{plan.blockers[0]}</div>
    {:else}
      <div class="plan">
        <div class="plan-head">
          回到第 {plan.toTurn} 轮之前 · 撤销回合 {plan.turns.join(", ")}
          {#if plan.scope !== "code"}· 删除 {plan.messageCount} 条消息{/if}
        </div>
        <div class="files">
          {#each plan.files as f (f.path)}
            <div class="file" class:restore={f.action === "restore"} class:del={f.action === "delete"} class:warn={f.action === "conflict"} class:skip={f.action === "skip"}>
              <span class="act">
                {f.action === "restore" ? "还原" : f.action === "delete" ? "删除" : f.action === "conflict" ? "冲突" : "跳过"}
              </span>
              <span class="path" title={f.path}>{shortPath(f.path)}</span>
              {#if f.reason}<span class="reason">{f.reason}</span>{/if}
            </div>
          {/each}
        </div>
        {#if plan.files.length === 0 && plan.scope === "all"}
          <div class="dim">该轮没有记录到文件改动</div>
        {/if}
        {#if plan.files.some((f) => f.action === "conflict")}
          <label class="force"><input type="checkbox" bind:checked={force} /> 强制覆盖有外部改动的文件（--force）</label>
        {/if}
        <div class="actions">
          <button class="btn danger" disabled={applying} onclick={() => (pendingScope = "all")}>回滚代码 + 对话</button>
          <button class="btn" disabled={applying} onclick={() => (pendingScope = "chat")}>仅对话</button>
          <button class="btn" disabled={applying} onclick={() => (pendingScope = "code")}>仅代码</button>
        </div>
        <div class="hint">
          <AlertTriangle size={12} />
          terminal_exec 造成的改动不可回滚（会列在「跳过」中）；回滚不删除历史事件，轨迹仍可查看
        </div>
      </div>
    {/if}
  {/if}

  {#if result}
    <div class="result">
      <div class="ok">
        ✓ 已回滚到第 {result.toTurn} 轮之前（{SCOPE_LABEL[result.scope]}）：还原 {result.restored.length} 文件{result.deleted.length > 0
          ? ` · 删除 ${result.deleted.length} 新建文件`
          : ""}{result.messagesDeleted > 0 ? ` · 移除 ${result.messagesDeleted} 条消息` : ""}
      </div>
      {#if result.conflicts.length > 0}
        <div class="warn-text">跳过 {result.conflicts.length} 个有外部改动的文件（勾选强制覆盖后重试）：</div>
        {#each result.conflicts as p (p)}
          <div class="path-line" title={p}>{shortPath(p)}</div>
        {/each}
      {/if}
      {#if result.skipped.length > 0}
        <div class="dim">跳过 {result.skipped.length} 项（不可恢复）：</div>
        {#each result.skipped.slice(0, 8) as s (s.path)}
          <div class="path-line" title={s.path}>{shortPath(s.path)} — {s.reason}</div>
        {/each}
      {/if}
    </div>
  {/if}
</div>

{#if pendingScope}
  <ConfirmModal
    title="确认回滚"
    danger
    confirmText="确认回滚"
    message={`回到第 ${selected} 轮之前（${SCOPE_LABEL[pendingScope]}）？将撤销回合 ${plan?.turns.join(", ") ?? ""}${pendingScope !== "code" ? `，并移除 ${plan?.messageCount ?? 0} 条消息` : ""}。此操作不可撤销。`}
    onConfirm={() => void apply(pendingScope as Scope)}
    onCancel={() => (pendingScope = null)}
  />
{/if}

<style>
  .rewind { display: flex; flex-direction: column; height: 100%; overflow-y: auto; font-size: 12px; }
  .head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 12px; border-bottom: 1px solid var(--border); position: sticky; top: 0;
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
  .empty, .error, .dim, .hint { color: var(--dim); padding: 12px; line-height: 1.6; }
  .error { color: var(--error); }
  .list { display: flex; flex-direction: column; }
  .turn {
    display: flex; flex-direction: column; gap: 2px; text-align: left;
    background: transparent; border: none; border-bottom: 1px solid var(--border);
    padding: 8px 12px; cursor: pointer; color: var(--text);
  }
  .turn:hover { background: var(--hover-bg); }
  .turn.active { background: var(--hover-bg); box-shadow: inset 2px 0 0 var(--primary); }
  .turn-no { font-weight: 600; }
  .turn-input { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .turn-meta { color: var(--dim); font-size: 11px; }
  .plan { padding: 10px 12px; border-top: 1px solid var(--border); }
  .plan-head { margin-bottom: 8px; color: var(--text); }
  .files { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
  .file { display: flex; align-items: center; gap: 6px; }
  .act { flex: 0 0 auto; font-size: 11px; padding: 1px 5px; border-radius: 4px; background: var(--hover-bg); color: var(--dim); }
  .file.restore .act { color: var(--primary); }
  .file.del .act { color: var(--error); }
  .file.warn .act { color: #d97706; }
  .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .reason { color: var(--dim); font-size: 11px; }
  .force { display: flex; align-items: center; gap: 6px; color: #d97706; margin-bottom: 8px; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .btn {
    padding: 6px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface); color: var(--text); font-size: 12px; cursor: pointer;
  }
  .btn:hover { background: var(--hover-bg); }
  .btn.danger { border-color: var(--error); color: var(--error); }
  .btn.danger:hover { background: var(--error); color: #fff; }
  .btn:disabled { opacity: .5; cursor: default; }
  .hint { display: flex; align-items: flex-start; gap: 6px; padding: 8px 0 0; font-size: 11px; }
  .result { padding: 10px 12px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 3px; }
  .ok { color: var(--primary); }
  .warn-text { color: #d97706; }
  .path-line { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
