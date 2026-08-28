<script lang="ts">
  /**
   * 应用窗口容器（Sprint 35）
   * 三形态（panel/float/widget）+ 拖拽/缩放/置顶/最小化 + iframe 沙箱 + postMessage 能力桥
   * 交互健壮性：pointer capture + document 级监听，resize 手柄 z-index 高于 iframe
   */
  import { onMount } from "svelte";
  import { X, Pin, PanelLeft, Maximize2 } from "lucide-svelte";
  import { setupBridgeHandler } from "$lib/app-bridge";
  import {
    winStates,
    setWinState,
    setAppSurface,
    openAppInPreview,
    closeAppWindow,
    type AppInfo,
    type AppSurface,
  } from "$lib/stores/apps.svelte";

  let { app }: { app: AppInfo } = $props();
  let iframeEl = $state<HTMLIFrameElement | null>(null);

  // $winStates 自动订阅（不能用 get()：$derived 里显式 get 不建立响应式依赖，窗口将无法移动/缩放）
  const st = $derived(
    $winStates[app.id] ?? { surface: "float" as AppSurface, x: 120, y: 90, w: 420, h: 320, pinned: false },
  );

  // widget 形态：iframe 带 surface 查询参数，宿主静态路由注入透明背景规则（框架负责小部件透明）；
  // v 参数携带版本号：应用更新（app/updated → version 变化）时 iframe 自动重载新内容
  const frameSrc = $derived(
    `/apps/${encodeURIComponent(app.id)}/index.html?v=${encodeURIComponent(app.version)}${st.surface === "widget" ? "&surface=widget" : ""}`,
  );

  const Z_INDEX: Record<AppSurface, number> = { panel: 100, float: 60, widget: 200 };

  function zIndex(): number {
    return st.pinned ? 210 : Z_INDEX[st.surface] ?? 60;
  }

  let dragging = false;

  function startDrag(e: PointerEvent) {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    // 指针捕获：即使拖到 iframe 上方（独立文档）也能持续收到 move
    const el = e.currentTarget as HTMLElement;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* 某些浏览器不支持则回退 window 级监听 */
    }
    dragging = true;
    const startX = e.clientX;
    const startY = e.clientY;
    const ox = st.x;
    const oy = st.y;
    const onMove = (ev: PointerEvent) => {
      if (!dragging) return;
      setWinState(app.id, { x: ox + ev.clientX - startX, y: oy + ev.clientY - startY });
    };
    const onUp = () => {
      dragging = false;
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  }

  let resizing = false;

  function startResize(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
    resizing = true;
    const startX = e.clientX;
    const startY = e.clientY;
    const ow = st.w;
    const oh = st.h;
    const onMove = (ev: PointerEvent) => {
      if (!resizing) return;
      setWinState(app.id, {
        w: Math.max(280, ow + ev.clientX - startX),
        h: Math.max(180, oh + ev.clientY - startY),
      });
    };
    const onUp = () => {
      resizing = false;
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  }

  // ─── postMessage 能力桥（沙箱 iframe origin 为 "null"，按 ev.source 身份校验；appId 绑定） ───
  onMount(() => {
    return setupBridgeHandler(iframeEl, app.id);
  });

  /** 形态切换：widget → float（小部件展开为浮窗）；float 停靠回右侧预览面板走 dock 按钮 */
  function toggleExpand() {
    if (st.surface === "widget") setAppSurface(app.id, "float");
  }
</script>

<div
  class="appwin"
  class:widget-mode={st.surface === "widget"}
  style:left={`${st.x}px`}
  style:top={`${st.y}px`}
  style:width={`${st.w}px`}
  style:height={`${st.h}px`}
  style:z-index={zIndex()}
  role="dialog"
  aria-label={app.name}
>
  <div class="aw-titlebar" onpointerdown={startDrag}>
    <span class="aw-title">{app.name}</span>
    <span class="aw-ver">v{app.version}</span>
    <div class="aw-btns">
      <button class="aw-btn" class:pinned={st.pinned} title="置顶/取消置顶" onclick={() => setWinState(app.id, { pinned: !st.pinned })}>
        <Pin size={12} />
      </button>
      {#if st.surface === "widget"}
        <button class="aw-btn" title="展开为浮窗（可拖拽/缩放）" onclick={toggleExpand}>
          <Maximize2 size={12} />
        </button>
      {:else}
        <button class="aw-btn" title="停靠回右侧应用预览面板" onclick={() => openAppInPreview(app.id)}>
          <PanelLeft size={12} />
        </button>
      {/if}
      <button class="aw-btn danger" title="关闭" onclick={() => closeAppWindow(app.id)}><X size={12} /></button>
    </div>
  </div>
  <div class="aw-body">
    <iframe
      bind:this={iframeEl}
      src={frameSrc}
      sandbox="allow-scripts allow-forms allow-modals"
      title={app.name}
    />
  </div>
  {#if st.surface === "float"}
    <div class="aw-resize" title="拖拽调整大小" onpointerdown={startResize}></div>
  {/if}
</div>

<style>
  .appwin {
    position: fixed;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 8px 32px rgba(0, 0, 0, .18);
    overflow: hidden;
    min-width: 280px;
    min-height: 180px;
  }
  .aw-titlebar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    cursor: move;
    user-select: none;
    flex-shrink: 0;
    touch-action: none;
  }
  .aw-title { font-size: 12px; font-weight: 600; color: var(--text); }
  .aw-ver { font-size: 10px; color: var(--dim); }
  .aw-btns { margin-left: auto; display: flex; gap: 2px; }
  .aw-btn {
    width: 24px; height: 24px;
    display: flex; align-items: center; justify-content: center;
    border: none; border-radius: 5px;
    background: transparent; color: var(--dim); cursor: pointer;
  }
  .aw-btn:hover { background: var(--hover-bg); color: var(--primary); }
  .aw-btn.pinned { color: var(--primary); }
  .aw-btn.danger:hover { color: var(--error); background: rgba(232, 84, 107, .12); }
  /* 主体透明（应用自行决定背景色；widget 宠物可透明悬浮） */
  .aw-body { position: relative; flex: 1; min-height: 0; background: transparent; }
  .appwin.widget-mode {
    background: transparent;
    border: none;
    box-shadow: none;
    overflow: visible;
    min-width: 0;
    min-height: 0;
  }
  .appwin.widget-mode .aw-body { background: transparent; }
  .appwin.widget-mode iframe { background: transparent; }
  /* widget：迷你工具条 hover 浮现（拖拽/展开/关闭），平时隐藏透明 */
  .appwin.widget-mode .aw-titlebar {
    position: absolute;
    top: -32px;
    left: 50%;
    transform: translateX(-50%);
    opacity: 0;
    transition: opacity .15s;
    background: rgba(0, 0, 0, .55);
    border: none;
    border-radius: 8px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, .3);
    color: #fff;
    white-space: nowrap;
    z-index: 20;
    padding: 3px 6px;
  }
  .appwin.widget-mode:hover .aw-titlebar { opacity: 1; }
  .appwin.widget-mode .aw-ver { color: rgba(255, 255, 255, .7); }
  .appwin.widget-mode .aw-btn { color: rgba(255, 255, 255, .85); }
  .appwin.widget-mode .aw-btn:hover { background: rgba(255, 255, 255, .18); color: #fff; }
  iframe {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: none;
  }
  .aw-resize {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 18px;
    height: 18px;
    cursor: nwse-resize;
    z-index: 10;
    touch-action: none;
    background: linear-gradient(135deg, transparent 50%, var(--border) 50%, var(--border) 60%, transparent 60%);
  }
  .aw-resize:hover { background: linear-gradient(135deg, transparent 50%, var(--primary) 50%, var(--primary) 65%, transparent 65%); }
</style>
