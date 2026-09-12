<script lang="ts">
  /**
   * 应用预览面板（Sprint 35/36）— 右侧面板「应用」Tab
   * 停靠的应用（iframe 内嵌）；支持点击切换「浮窗」（拖拽/缩放）/「小部件」（透明悬浮）
   * （文档与文件改动已合并进「产物」Tab，见 ArtifactsPanel）
   */
  import { onMount } from "svelte";
  import { AppWindow, Dock, X, PanelLeft } from "lucide-svelte";
  import { setupBridgeHandler } from "$lib/app-bridge";
  import {
    apps,
    openWindows,
    winStates,
    previewAppId,
    setAppSurface,
    openAppInPreview,
    closeAppWindow,
  } from "$lib/stores/apps.svelte";

  let iframeEl = $state<HTMLIFrameElement | null>(null);

  /** 停靠在右侧面板的 webapp（panel 形态，仅运行中） */
  const docked = $derived(
    $apps.filter(
      (a) => a.type === "app" && a.status === "running" && $openWindows[a.id] && ($winStates[a.id]?.surface ?? "panel") === "panel",
    ),
  );
  /** 悬浮/小部件形态的应用（可停靠回来，仅运行中） */
  const floatApps = $derived(
    $apps.filter(
      (a) => a.type === "app" && a.status === "running" && $openWindows[a.id] && ($winStates[a.id]?.surface ?? "panel") !== "panel",
    ),
  );
  /** 预览选中（左侧应用列表点击/启动时联动；缺省回退到最近停靠的应用） */
  const activeApp = $derived(docked.find((a) => a.id === $previewAppId) ?? docked[docked.length - 1]);

  // 停靠 iframe 能力桥：activeApp 切换时重挂（setupBridgeHandler 返回清理函数）
  $effect(() => {
    const app = activeApp;
    if (!app) return;
    return setupBridgeHandler(iframeEl, app.id);
  });
</script>

<div class="apv">
  {#if activeApp}
    <div class="apv-head">
      <span class="apv-appname" title={activeApp.id}>{activeApp.name} <span class="apv-ver">v{activeApp.version}</span></span>
      <div class="apv-actions">
        <button class="apv-btn" title="切换为浮窗（可拖拽/缩放）" onclick={() => setAppSurface(activeApp.id, "float")}><AppWindow size={12} /></button>
        <button class="apv-btn" title="切换为小部件（透明悬浮）" onclick={() => setAppSurface(activeApp.id, "widget")}><Dock size={12} /></button>
        <button class="apv-btn danger" title="关闭预览" onclick={() => closeAppWindow(activeApp.id)}><X size={12} /></button>
      </div>
    </div>
    <div class="apv-body">
      <iframe
        bind:this={iframeEl}
        src={`/apps/${encodeURIComponent(activeApp.id)}/index.html?v=${encodeURIComponent(activeApp.version)}`}
        sandbox="allow-scripts allow-forms allow-modals"
        title={activeApp.name}
      />
    </div>
  {:else}
    <div class="apv-empty">
      <div>暂无停靠预览</div>
      <span>新生成的应用默认展示在此，可点击切换为浮窗/小部件</span>
      {#if floatApps.length > 0}
        <div class="apv-float-list">
          {#each floatApps as a (a.id)}
            <div class="apv-float-item">
              <span class="apv-float-name">{a.name}</span>
              <button class="apv-btn" title="停靠到预览面板" onclick={() => openAppInPreview(a.id)}><PanelLeft size={12} /></button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .apv { height: 100%; display: flex; flex-direction: column; gap: 8px; min-height: 0; position: relative; }
  .apv-head { display: flex; align-items: center; gap: 8px; padding: 2px 4px 6px; min-width: 0; }
  .apv-appname { font-size: 12px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .apv-ver { font-size: 10px; color: var(--dim); font-weight: 400; }
  .apv-actions { display: flex; gap: 4px; flex-shrink: 0; }
  .apv-btn {
    width: 24px; height: 24px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface); color: var(--dim); cursor: pointer;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .apv-btn:hover { background: var(--hover-bg); color: var(--primary); }
  .apv-btn.danger:hover { color: var(--error); border-color: var(--error); }
  .apv-body { flex: 1; min-height: 0; position: relative; }
  .apv-body iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .apv-empty { color: var(--dim); font-size: 12px; text-align: center; padding: 32px 0; line-height: 1.8; display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .apv-empty > div { font-size: 13px; color: var(--text); font-weight: 600; }
  .apv-float-list { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; width: 100%; max-width: 260px; }
  .apv-float-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); }
  .apv-float-name { font-size: 12px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
