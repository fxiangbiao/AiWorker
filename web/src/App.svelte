<script lang="ts">
  import "./app.css";
  import { onMount } from "svelte";
  import TopBar from "./components/TopBar.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import ChatPanel from "./components/ChatPanel.svelte";
  import SystemPanel from "./components/SystemPanel.svelte";
  import FileDiffPanel from "./components/FileDiffPanel.svelte";
  import StatusBar from "./components/StatusBar.svelte";
  import { skills } from "./lib/stores/status";
  import {
    store,
    loadChats,
    loadSettings,
    loadMessages,
    saveChats,
    syncServerSessions,
    loadRemoteMessages,
    API,
  } from "./lib/stores/chat.svelte";
  import { serverOnline, currentModel, totalTokens, workingDir } from "./lib/stores/status";
  import { initWs } from "./lib/stores/ws.svelte";
  import { fmtN } from "./lib/utils/format";

  let agents: { id: string; name: string }[] = $state([]);
  let leftHidden = $state(false);
  let rightHidden = $state(false);
  let rightWidth = $state<number | null>(null); // null = 默认 40%
  let systemOpen = $state(false);

  function startDrag(e: PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = rightWidth ?? window.innerWidth * 0.4;
    const onMove = (ev: PointerEvent) => {
      const delta = startX - ev.clientX;
      const w = Math.min(Math.max(startW + delta, 280), window.innerWidth * 0.7);
      rightWidth = w;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function pollStatus() {
    fetch(`${API}/status`)
      .then((r) => r.json())
      .then((d) => {
        totalTokens.set(d.tokenUsage?.total || 0);
        currentModel.set(d.model || "--");
        workingDir.set(d.workingDir || "");
        skills.set(d.skills || []);
        serverOnline.set(true);
      })
      .catch(() => serverOnline.set(false));
  }

  function loadAgents() {
    fetch(`${API}/agents`)
      .then((r) => r.json())
      .then((d) => {
        agents = d.agents || [];
      })
      .catch(() => {
        agents = [{ id: "default", name: "default" }];
      });
  }

  function handleNewChat() {
    const id = "c" + Date.now().toString(36);
    store.chats.unshift({ id, title: "新对话", agentId: "default", turns: 0, createdAt: Date.now() });
    store.activeChatId = id;
    store.messages.length = 0;
    saveChats(store.chats);
  }

  async function handleSwitch(id: string) {
    store.activeChatId = id;
    const loaded = loadMessages(id);
    if (loaded.length === 0) {
      const remote = await loadRemoteMessages(id);
      store.messages.length = 0;
      store.messages.push(...remote);
    } else {
      store.messages.length = 0;
      store.messages.push(...loaded);
    }
  }

  onMount(() => {
    loadSettings();
    loadChats();
    loadAgents();
    if (store.chats.length > 0) {
      store.activeChatId = store.chats[0].id;
      const loaded = loadMessages(store.chats[0].id);
      store.messages.length = 0;
      store.messages.push(...loaded);
    }
    pollStatus();
    initWs();
    // 服务器会话合并（排序最新在前）后，若出现了新的最新会话（如 TUI 中产生的新对话），切到最新
    syncServerSessions().then((hadNew) => {
      if (hadNew) {
        const newest = store.chats[0];
        if (newest && newest.id !== store.activeChatId) {
          void handleSwitch(newest.id);
        }
      }
    });
    const intv = setInterval(pollStatus, 30000);
    return () => clearInterval(intv);
  });
</script>

<div id="topbar">
  <TopBar
    {agents}
    {leftHidden}
    {rightHidden}
    onOpenSystem={() => (systemOpen = true)}
    onExpandLeft={() => (leftHidden = false)}
    onExpandRight={() => (rightHidden = false)}
  />
</div>
<div id="main">
  {#if !leftHidden}
    <Sidebar onNewChat={handleNewChat} onSwitch={handleSwitch} onHide={() => (leftHidden = true)} />
  {/if}
  <ChatPanel />
  {#if !rightHidden}
    <div class="resizer" onpointerdown={startDrag}></div>
    <div class="right-panel" id="right-panel" style:width={rightWidth ? `${rightWidth}px` : "40%"}>
      <div class="rp-tabs">
        <button class="rp-tab active" onclick={() => {}}>
          <span class="rp-ico">&#128196;</span>文件变更
        </button>
        <button class="rp-hide" title="隐藏右侧栏" onclick={() => (rightHidden = true)}>&#8811;</button>
      </div>
      <FileDiffPanel />
    </div>
  {/if}
</div>

{#if systemOpen}
  <div class="modal-overlay" onclick={() => (systemOpen = false)}>
    <div class="modal-box" onclick={(e) => e.stopPropagation()}>
      <div class="modal-head">
        <span>系统</span>
        <button class="modal-close" onclick={() => (systemOpen = false)}>&#10005;</button>
      </div>
      <SystemPanel />
    </div>
  </div>
{/if}
<StatusBar />

<style>
  #main { display: flex; flex: 1; overflow: hidden; }
  .right-panel {
    flex: 0 0 auto;
    background: var(--surface);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    overflow-y: auto;
    padding: 14px 16px;
  }
  .resizer {
    width: 5px;
    cursor: col-resize;
    background: transparent;
    flex-shrink: 0;
    transition: background .15s;
  }
  .resizer:hover { background: var(--primary-light); }
  .rp-tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 12px;
  }
  .rp-tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--dim);
    font-family: var(--font-ui);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .rp-tab.active { color: var(--primary); border-bottom-color: var(--primary); }
  .rp-ico { font-size: 13px; }
  .rp-hide {
    padding: 4px 10px;
    background: transparent;
    border: none;
    color: var(--dim);
    font-size: 13px;
    cursor: pointer;
    border-radius: var(--radius-sm);
  }
  .rp-hide:hover { background: var(--hover-bg); color: var(--primary); }
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(26, 29, 46, .35);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .modal-box {
    /* 固定为页面宽度 50%（min-width 保证小屏可用性） */
    width: 50vw;
    min-width: 720px;
    max-width: 90vw;
    height: 75vh;
    background: var(--surface);
    border-radius: var(--radius);
    box-shadow: 0 8px 40px rgba(26, 29, 46, .2);
    padding: 20px;
    display: flex;
    flex-direction: column;
  }
  .modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 16px;
  }
  .modal-close {
    background: transparent;
    border: none;
    color: var(--dim);
    font-size: 16px;
    cursor: pointer;
  }
  .modal-close:hover { color: var(--text); }
  .rp-section { margin-bottom: 20px; }
  .rp-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; color: var(--dim); margin-bottom: 8px; }
  .skill-item { font-size: 12px; padding: 2px 0; }
  .empty { color: var(--dim); font-size: 12px; }
</style>
