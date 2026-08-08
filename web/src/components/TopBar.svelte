<script lang="ts">
  import ModeTabs from "./ModeTabs.svelte";
  import AgentSelect from "./AgentSelect.svelte";
  import { store } from "$lib/stores/chat.svelte";

  let { agents = [] as { id: string; name: string }[], onOpenSystem, onExpandLeft, onExpandRight, leftHidden, rightHidden } = $props<{
    agents?: { id: string; name: string }[];
    onOpenSystem: () => void;
    onExpandLeft: () => void;
    onExpandRight: () => void;
    leftHidden: boolean;
    rightHidden: boolean;
  }>();
</script>

<div class="topbar">
  {#if leftHidden}
    <button class="side-btn" title="展开左侧栏" onclick={onExpandLeft}>&#8811;</button>
  {/if}
  <div class="logo"><img src="/logo.svg" alt="AiWorker" class="logo-img" />AiWorker</div>
  <ModeTabs mode={store.mode} onSelect={(m) => (store.mode = m)} />
  <AgentSelect agentId={store.agentId} {agents} onchange={(id) => (store.agentId = id)} />
  <div class="spacer"></div>
  <button class="side-btn" title="系统设置" onclick={onOpenSystem}>&#9881;</button>
  {#if rightHidden}
    <button class="side-btn" title="展开右侧栏" onclick={onExpandRight}>&#8810;</button>
  {/if}
</div>

<style>
  .topbar {
    height: 48px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    padding: 0 16px;
    gap: 16px;
    flex-shrink: 0;
    box-shadow: 0 1px 2px rgba(0, 0, 0, .02);
    z-index: 10;
  }
  .logo {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    font-size: 15px;
    color: var(--text);
    letter-spacing: -.2px;
  }
  .logo-img { width: 26px; height: 26px; border-radius: 7px; }
  .spacer { flex: 1; }
  .side-btn {
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
  }
  .side-btn:hover { background: var(--hover-bg); color: var(--primary); }
</style>
