<script lang="ts">
  import "./app.css";
  import { onMount } from "svelte";
  import TopBar from "./components/TopBar.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import ChatPanel from "./components/ChatPanel.svelte";
  import SystemPanel from "./components/SystemPanel.svelte";
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
  import { serverOnline, currentModel, totalTokens, workingDir, projectDir } from "./lib/stores/status";
  import { fmtN } from "./lib/utils/format";

  let agents: { id: string; name: string }[] = $state([]);
  let rightHidden = $state(false);

  function pollStatus() {
    fetch(`${API}/status`)
      .then((r) => r.json())
      .then((d) => {
        totalTokens.set(d.tokenUsage?.total || 0);
        currentModel.set(d.model || "--");
        workingDir.set(d.workingDir || "");
        projectDir.set(d.projectDir || "");
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
    syncServerSessions();
    const intv = setInterval(pollStatus, 30000);
    return () => clearInterval(intv);
  });
</script>

<div id="topbar"><TopBar {agents} /></div>
<div id="main">
  <Sidebar onNewChat={handleNewChat} onSwitch={handleSwitch} />
  <ChatPanel />
  <div class="right-panel" id="right-panel">
    <div class="rp-section">
      <div class="rp-title">系统</div>
      <SystemPanel />
    </div>
  </div>
</div>
<StatusBar />

<style>
  #main { display: flex; flex: 1; overflow: hidden; }
  .right-panel {
    width: var(--right-w);
    background: var(--surface);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    overflow-y: auto;
    padding: 16px;
  }
  .rp-section { margin-bottom: 20px; }
  .rp-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; color: var(--dim); margin-bottom: 8px; }
  .skill-item { font-size: 12px; padding: 2px 0; }
  .empty { color: var(--dim); font-size: 12px; }
</style>
