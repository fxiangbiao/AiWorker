<script lang="ts">
  import { API, store, deleteChat, renameChat, exportChat } from "$lib/stores/chat.svelte";
  import { stream } from "$lib/stores/stream.svelte";
  import { MessageSquare, Box, ListChecks, Settings, Cpu, PanelLeftClose } from "lucide-svelte";
  import ConfirmModal from "./ConfirmModal.svelte";
  import AppsPanel from "./AppsPanel.svelte";
  import ProcessesPanel from "./ProcessesPanel.svelte";
  import JobsPanel from "./JobsPanel.svelte";
  import { sidebarNav } from "$lib/stores/apps.svelte";

  let { onNewChat, onSwitch, onHide, onOpenSystem } = $props<{
    onNewChat: () => void;
    onSwitch: (id: string) => void;
    onHide: () => void;
    onOpenSystem: () => void;
  }>();

  type NavTab = "chat" | "apps" | "processes" | "jobs";

  const NAV_ITEMS: { id: NavTab; label: string; icon: typeof Box }[] = [
    { id: "chat", label: "对话", icon: MessageSquare },
    { id: "apps", label: "应用", icon: Box },
    { id: "processes", label: "进程", icon: Cpu },
    { id: "jobs", label: "任务", icon: ListChecks },
  ];

  interface SStats {
    sessionId: string;
    toolCallsFailed: number;
    tokensTotal: number;
    errorCount: number;
  }
  let statsMap = $state<Record<string, SStats>>({});

  function loadStats() {
    fetch(`${API}/stats`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        const m: Record<string, SStats> = {};
        for (const s of (d.stats || []) as SStats[]) m[s.sessionId] = s;
        statsMap = m;
      })
      .catch(() => {});
  }
  $effect(() => {
    loadStats();
  });

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

  /** 会话列表：应用生成后台会话（agentId === "appgen"）不展示——生成过程已在对话流的实时状态卡片中 */
  const chatSessions = $derived(store.chats.filter((c) => c.agentId !== "appgen"));

  const groups = $derived(() => {
    const map = new Map<string, typeof store.chats>();
    for (const c of [...chatSessions].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))) {
      const k = dayKey(c.createdAt || 0);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(c);
    }
    return [...map.entries()];
  });
</script>

<div class="sidebar">
  <div class="s-nav">
    {#each NAV_ITEMS as item (item.id)}
      <button class="s-nav-btn" class:active={$sidebarNav === item.id} title={item.label} onclick={() => sidebarNav.set(item.id)}>
        <item.icon size={14} />
        <span>{item.label}</span>
      </button>
    {/each}
    <button class="s-nav-fixed" title="设置" onclick={onOpenSystem}>
      <Settings size={14} />
    </button>
    <button class="s-nav-fixed" title="隐藏左侧栏" onclick={onHide}>
      <PanelLeftClose size={14} />
    </button>
  </div>

  {#if $sidebarNav === "chat"}
    <div class="s-top">
      <button class="new-btn" onclick={onNewChat}>+ 新对话</button>
    </div>
    <div class="s-chats">
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
                {#if c.workingDir}
                  <span class="s-dir" title={`项目目录: ${c.workingDir}`}>📁</span>
                {/if}
                {#if statsMap[c.id]}
                  <span class:bad={(statsMap[c.id].toolCallsFailed ?? 0) > 0}>
                    {(statsMap[c.id].tokensTotal ?? 0) >= 1000 ? `${((statsMap[c.id].tokensTotal ?? 0) / 1000).toFixed(1)}k` : (statsMap[c.id].tokensTotal ?? 0)} tok
                    {#if (statsMap[c.id].toolCallsFailed ?? 0) > 0}· 失败 {statsMap[c.id].toolCallsFailed}{/if}
                  </span>
                {/if}
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
        {#if chatSessions.length === 0}
          <div class="s-empty">暂无会话</div>
        {/if}
      </div>
    </div>
  {:else if $sidebarNav === "apps"}
    <AppsPanel />
  {:else if $sidebarNav === "processes"}
    <ProcessesPanel />
  {:else if $sidebarNav === "jobs"}
    <JobsPanel />
  {/if}
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
  .s-nav {
    display: flex;
    gap: 2px;
    padding: 8px 8px 4px;
    border-bottom: 1px solid var(--border);
  }
  .s-nav-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 6px 4px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--dim);
    font-family: var(--font-ui);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
  }
  .s-nav-btn:hover { background: var(--hover-bg); color: var(--primary); }
  .s-nav-btn.active { background: var(--primary-light); color: var(--primary); }
  .s-nav-fixed {
    width: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 6px 0;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--dim);
    cursor: pointer;
    flex-shrink: 0;
  }
  .s-nav-fixed:hover { background: var(--hover-bg); color: var(--primary); }
  .s-top { padding: 12px; display: flex; gap: 8px; align-items: center; }
  .new-btn {
    flex: 1;
    padding: 9px;
    background: var(--primary);
    color: #fff;
    border: none;
    border-radius: var(--radius-sm);
    font-family: var(--font-ui);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .new-btn:hover { background: var(--primary-hover); }
  .s-list { overflow-y: auto; padding: 0; flex: 1; min-height: 0; }
  .s-chats { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 0 8px; }
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
  .s-meta .bad { color: #e5484d; }
  .s-time { color: var(--primary); font-weight: 500; }
  .s-dir { cursor: help; font-size: 10px; }
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
