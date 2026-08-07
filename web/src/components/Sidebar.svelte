<script lang="ts">
  import { store } from "$lib/stores/chat.svelte";
  import { stream } from "$lib/stores/stream.svelte";

  let { onNewChat, onSwitch } = $props<{
    onNewChat: () => void;
    onSwitch: (id: string) => void;
  }>();

  function handleClick(id: string) {
    if (stream.sending) return;
    onSwitch(id);
  }
</script>

<div class="sidebar">
  <div class="s-top">
    <button class="new-btn" onclick={onNewChat}>+ 新对话</button>
  </div>
  <div class="s-list">
    {#each store.chats as c}
      <div
        class="s-item"
        class:active={c.id === store.activeChatId}
        onclick={() => handleClick(c.id)}
        onkeydown={(e) => e.key === "Enter" && handleClick(c.id)}
        role="button"
        tabindex="0"
      >
        <div class="s-title">{c.title}</div>
        <div class="s-meta">{c.turns || 0} 轮 &middot; {c.agentId || "default"}</div>
      </div>
    {/each}
  </div>
</div>

<style>
  .sidebar {
    width: var(--sidebar-w);
    background: var(--surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }
  .s-top { padding: 12px; }
  .new-btn {
    width: 100%;
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
  .s-list { flex: 1; overflow-y: auto; padding: 0 8px; }
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
  .s-meta { font-size: 11px; color: var(--dim); margin-top: 2px; }
</style>
