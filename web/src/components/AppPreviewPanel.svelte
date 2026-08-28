<script lang="ts">
  /**
   * 应用预览面板（Sprint 35）— 右侧面板「应用预览」Tab
   * 统一展示：停靠的应用（iframe 内嵌）+ 生成的文档（Markdown 渲染）
   * 支持点击切换「浮窗」（拖拽/缩放）/「小部件」（透明悬浮）
   */
  import { onMount } from "svelte";
  import { AppWindow, Dock, X, FileText, PanelLeft } from "lucide-svelte";
  import { API } from "$lib/stores/chat.svelte";
  import { setupBridgeHandler } from "$lib/app-bridge";
  import {
    apps,
    openWindows,
    winStates,
    docViewer,
    previewAppId,
    setAppSurface,
    openAppInPreview,
    closeAppWindow,
  } from "$lib/stores/apps.svelte";
  import DocRenderer from "./DocRenderer.svelte";

  let iframeEl = $state<HTMLIFrameElement | null>(null);
  let docList = $state<{ path: string; title: string }[]>([]);
  /** 文档列表浮层开关（独立于当前显示状态，随时可重新打开历史文档） */
  let docListOpen = $state(false);

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
  const docPath = $derived($docViewer);

  async function loadDocs() {
    try {
      const r = await fetch(`${API}/docs`);
      if (!r.ok) return;
      const d = (await r.json()) as { docs?: { path: string; title: string; size: number }[] };
      docList = d.docs ?? [];
    } catch {
      /* 忽略 */
    }
  }

  // 文档打开/切换时刷新文档列表（新生成的文档出现在 chips）
  $effect(() => {
    const p = $docViewer;
    if (p) void loadDocs();
  });

  // 停靠 iframe 能力桥：activeApp 切换时重挂（setupBridgeHandler 返回清理函数）
  $effect(() => {
    const app = activeApp;
    if (!app) return;
    return setupBridgeHandler(iframeEl, app.id);
  });

  onMount(() => {
    void loadDocs();
  });
</script>

<div class="apv">
  {#if docPath}
    <div class="apv-head">
      <span class="apv-title"><FileText size={12} /> 文档</span>
      {#if docList.length > 0}
        <div class="apv-chips">
          {#each docList as d (d.path)}
            <button class="apv-chip" class:active={docPath === d.path} onclick={() => docViewer.set(d.path)}>{d.title}</button>
          {/each}
        </div>
      {/if}
      <button class="apv-btn" title="关闭文档" onclick={() => docViewer.set(null)}><X size={12} /></button>
    </div>
    <div class="apv-body">
      <DocRenderer path={docPath} />
    </div>
  {:else if activeApp}
    <div class="apv-head">
      <span class="apv-appname" title={activeApp.id}>{activeApp.name} <span class="apv-ver">v{activeApp.version}</span></span>
      {#if docList.length > 0}
        <button class="apv-docbtn" class:open={docListOpen} title="查看文档（报告/方案等）" onclick={() => (docListOpen = !docListOpen)}><FileText size={12} /> 文档</button>
      {/if}
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
      {#if docList.length > 0}
        <button class="apv-docbtn" class:open={docListOpen} title="查看文档（报告/方案等）" onclick={() => (docListOpen = !docListOpen)}><FileText size={12} /> 文档</button>
      {/if}
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

  <!-- 文档列表浮层：独立于当前显示状态，随时可重新打开历史文档 -->
  {#if docListOpen && docList.length > 0}
    <div class="apv-docpop">
      <div class="apv-docpop-title">文档</div>
      {#each docList as d (d.path)}
        <button
          class="apv-docpop-item"
          class:active={docPath === d.path}
          onclick={() => {
            docViewer.set(d.path);
            docListOpen = false;
          }}
        >
          {d.title}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .apv { height: 100%; display: flex; flex-direction: column; gap: 8px; min-height: 0; position: relative; }
  .apv-head { display: flex; align-items: center; gap: 8px; padding: 2px 4px 6px; min-width: 0; }
  .apv-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; color: var(--dim); display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
  .apv-appname { font-size: 12px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .apv-ver { font-size: 10px; color: var(--dim); font-weight: 400; }
  .apv-chips { display: flex; gap: 4px; overflow-x: auto; flex: 1; min-width: 0; scrollbar-width: thin; }
  .apv-chip {
    flex-shrink: 0; padding: 3px 8px;
    border: 1px solid var(--border); border-radius: 10px;
    background: var(--surface); color: var(--dim);
    font-size: 11px; cursor: pointer; white-space: nowrap; max-width: 140px; overflow: hidden; text-overflow: ellipsis;
  }
  .apv-chip:hover { border-color: var(--primary); color: var(--primary); }
  .apv-chip.active { background: var(--primary); border-color: var(--primary); color: #fff; }
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
  .apv-docbtn {
    display: flex; align-items: center; gap: 4px; padding: 4px 8px; flex-shrink: 0;
    border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface); color: var(--dim); font-size: 11px; cursor: pointer;
  }
  .apv-docbtn:hover { background: var(--hover-bg); color: var(--primary); border-color: var(--primary); }
  .apv-docbtn.open { background: var(--primary-light); color: var(--primary); border-color: var(--primary); }
  /* 文档列表浮层（绝对定位于面板顶部，独立于当前显示状态） */
  .apv-docpop {
    position: absolute; top: 34px; right: 4px; z-index: 40;
    width: 240px; max-height: 60%; overflow-y: auto;
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm);
    box-shadow: 0 6px 24px rgba(0, 0, 0, .18);
    padding: 6px;
  }
  .apv-docpop-title { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; color: var(--dim); padding: 4px 6px 6px; }
  .apv-docpop-item {
    display: block; width: 100%; text-align: left;
    padding: 6px 8px; margin-bottom: 1px;
    border: none; border-radius: 4px; background: transparent;
    color: var(--text); font-family: var(--font-ui); font-size: 12px;
    cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .apv-docpop-item:hover { background: var(--hover-bg); }
  .apv-docpop-item.active { background: var(--primary-light); color: var(--primary); font-weight: 600; }
</style>
