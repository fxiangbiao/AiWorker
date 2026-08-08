<script lang="ts">
  import { store, deleteChat, renameChat, exportChat } from "$lib/stores/chat.svelte";
  import { stream } from "$lib/stores/stream.svelte";
  import ConfirmModal from "./ConfirmModal.svelte";

  let { onNewChat, onSwitch, onHide } = $props<{
    onNewChat: () => void;
    onSwitch: (id: string) => void;
    onHide: () => void;
  }>();

  let menuFor = $state<string | null>(null);
  let modal: { type: "delete"; id: string } | { type: "rename"; id: string } | null = $state(null);

  function handleClick(id: string) {
    if (stream.sending) return;
    onSwitch(id);
  }

  function handleDelete(id: string) {
    menuFor = null;
    modal = { type: "delete", id };
  }

  function handleRename(id: string) {
    menuFor = null;
    modal = { type: "rename", id };
  }

  async function confirmDelete(id: string) {
    await deleteChat(id);
    modal = null;
  }

  async function confirmRename(id: string, title?: string) {
    if (title && title.trim()) {
      await renameChat(id, title.trim());
    }
    modal = null;
  }

  function handleExport(id: string) {
    menuFor = null;
    const chat = store.chats.find((c) => c.id === id);
    exportChat(id, chat?.title ?? id);
  }

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
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }

  function fmtTime(ts: number): string {
    if (!ts) return "";
    const d = new Date(ts);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
  }

  const groups = $derived(() => {
    const map = new Map<string, typeof store.chats>();
    for (const c of [...store.chats].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))) {
      const k = dayKey(c.createdAt || 0);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(c);
    }
    return [...map.entries()];
  });
</script>

<div class="sidebar">
  <div class="s-top">
    <button class="new-btn" onclick={onNewChat}>+ 新对话</button>
    <button class="hide-btn" title="隐藏左侧栏" onclick={onHide}>&#8810;</button>
  </div>
  <div class="s-list">
    {#each groups() as [key, chats]}
      <div class="s-group">{dayLabel(chats[0].createdAt || 0)}</div>
      {#each chats as c}
        <div
          class="s-item"
          class:active={c.id === store.activeChatId}
          onclick={() => handleClick(c.id)}
          onkeydown={(e) => e.key === "Enter" && handleClick(c.id)}
          onmouseenter={() => (menuFor = c.id)}
          onmouseleave={() => (menuFor = null)}
          role="button"
          tabindex="0"
        >
          <div class="s-title">{c.title}</div>
          <div class="s-meta">
            <span class="s-time">{fmtTime(c.createdAt)}</span>
            <span>{c.turns || 0} 轮 &middot; {c.agentId || "default"}</span>
          </div>
          {#if menuFor === c.id}
            <div class="s-actions" onclick={(e) => e.stopPropagation()}>
              <button class="sa-btn" title="重命名" onclick={() => handleRename(c.id)}>&#9998;</button>
              <button class="sa-btn" title="导出 Markdown" onclick={() => handleExport(c.id)}>&#11015;</button>
              <button class="sa-btn danger" title="删除" onclick={() => handleDelete(c.id)}>&#10005;</button>
            </div>
          {/if}
        </div>
      {/each}
    {/each}
    {#if store.chats.length === 0}
      <div class="s-empty">暂无会话</div>
    {/if}
  </div>
</div>

{#if modal}
  {#if modal.type === "delete"}
    <ConfirmModal
      title="删除会话"
      message="确定删除该会话？此操作不可恢复。"
      confirmText="删除"
      danger
      onConfirm={() => confirmDelete(modal.id)}
      onCancel={() => (modal = null)}
    />
  {:else if modal.type === "rename"}
    {@const chat = store.chats.find((c) => c.id === modal.id)}
    <ConfirmModal
      title="重命名会话"
      mode="input"
      inputLabel="新标题"
      inputValue={chat?.title ?? ""}
      confirmText="保存"
      onConfirm={(v) => confirmRename(modal.id, v)}
      onCancel={() => (modal = null)}
    />
  {/if}
{/if}

<style>
  .sidebar {
    width: var(--sidebar-w);
    background: var(--surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }
  .s-top { padding: 12px; display: flex; gap: 8px; align-items: center; }
  .new-btn {
    flex: 1;
    padding: 9px;
    background: var(--text);
    color: #fff;
    border: none;
    border-radius: var(--radius-sm);
    font-family: var(--font-ui);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .hide-btn {
    width: 32px;
    height: 32px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--dim);
    font-size: 14px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .hide-btn:hover { background: var(--hover-bg); color: var(--primary); }
  .s-list { flex: 1; overflow-y: auto; padding: 0 8px; }
  .s-group {
    font-size: 11px;
    font-weight: 600;
    color: var(--dim);
    padding: 10px 12px 4px;
    text-transform: uppercase;
    letter-spacing: .5px;
  }
  .s-empty { font-size: 12px; color: var(--dim); padding: 24px; text-align: center; }
  .s-item {
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    margin-bottom: 2px;
    transition: background .1s;
  }
  .s-item:hover { background: var(--hover-bg); }
  .s-item.active { background: var(--primary-light); border: 1px solid rgba(75, 117, 238, .15); }
  .s-title { font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .s-meta { font-size: 11px; color: var(--dim); margin-top: 2px; display: flex; gap: 8px; align-items: center; }
  .s-time { color: var(--primary); font-weight: 500; }
  .s-actions { position: absolute; top: 8px; right: 8px; display: flex; gap: 2px; }
  .s-item { position: relative; }
  .sa-btn {
    width: 22px; height: 22px;
    display: flex; align-items: center; justify-content: center;
    border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface); color: var(--dim); font-size: 10px;
    cursor: pointer;
  }
  .sa-btn:hover { background: var(--hover-bg); color: var(--primary); }
  .sa-btn.danger:hover { color: var(--error); border-color: var(--error); }
</style>
