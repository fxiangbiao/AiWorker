<script module lang="ts">
  /** 跨打开保留用户手动调整的尺寸（px），FilePreview 每次挂载一份实例但此值模块级共享 */
  let lastSize: { w: number; h: number } | null = null;
</script>

<script lang="ts">
  /**
   * 工具产物预览面板（Sprint 45+）：按 artifact kind 分派渲染。
   * - .md → 复用 DocRenderer（走 /docs/content，保留现有 Markdown 预览）
   * - 其他文本/代码 → /files 拉取原文 <pre> 展示
   * - 图片/视频/音频/PDF → 原生元素（/files，支持 Range）
   * - Office → docx(mammoth)/xlsx(SheetJS) 前端转换（dynamic import，失败回退下载）；pptx 等下载兜底
   * - diff → +/- 着色行渲染
   * - 窗口：右下角拖拽调整大小（尺寸跨打开记忆）+ 全屏切换（Esc 先退全屏再关闭）
   */
  import DOMPurify from "dompurify";
  import { API } from "$lib/stores/chat.svelte";
  import type { ToolArtifact } from "$lib/artifacts";
  import { artifactIcon, formatBytes, baseName } from "$lib/artifacts";
  import DocRenderer from "./DocRenderer.svelte";

  let { sessionId, artifact, onClose } = $props<{
    sessionId?: string | null;
    artifact: ToolArtifact | null;
    onClose: () => void;
  }>();

  // —— 窗口：右下角拖拽调整大小 + 全屏切换 ——
  let cur = $state<{ w: number; h: number } | null>(null);
  let fsMode = $state(false);
  let resizing = false;
  let r0 = { x: 0, y: 0, w: 0, h: 0 };
  let cardCss = $derived.by(() => (!fsMode && cur ? `width:${cur.w}px;height:${cur.h}px;` : ""));
  let bodyEl = $state<HTMLElement | null>(null);

  $effect(() => {
    void artifact; // 打开/切换产物：退出全屏并恢复上次手动尺寸（无则 CSS 默认）
    fsMode = false;
    let s = lastSize;
    if (s) {
      // 视口变小过则收窄，避免拖拽柄越出屏幕
      const maxW = Math.max(300, window.innerWidth - 48);
      const maxH = Math.max(180, window.innerHeight - 48);
      s = { w: Math.min(s.w, maxW), h: Math.min(s.h, maxH) };
    }
    cur = s;
    bodyEl?.scrollTo(0, 0); // 切换产物时回到顶部，避免停留在上一文件的滚动位置
  });

  // Esc：全屏时先退出全屏，否则关闭预览
  $effect(() => {
    if (!artifact) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      if (fsMode) fsMode = false;
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function startResize(ev: PointerEvent) {
    if (fsMode) return;
    ev.preventDefault();
    ev.stopPropagation();
    const card = (ev.currentTarget as HTMLElement).parentElement;
    const r = card?.getBoundingClientRect();
    if (!r) return;
    r0 = { x: ev.clientX, y: ev.clientY, w: r.width, h: r.height };
    resizing = true;
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  }
  function moveResize(ev: PointerEvent) {
    if (!resizing) return;
    const pad = 24; // 与 .fp-overlay 的 padding 一致，保证不越出视口
    const minW = 300;
    const minH = 180;
    const maxW = Math.max(minW, window.innerWidth - pad * 2);
    const maxH = Math.max(minH, window.innerHeight - pad * 2);
    const w = Math.min(Math.max(r0.w + (ev.clientX - r0.x), minW), maxW);
    const h = Math.min(Math.max(r0.h + (ev.clientY - r0.y), minH), maxH);
    cur = { w, h };
  }
  function endResize(ev: PointerEvent) {
    if (!resizing) return;
    resizing = false;
    try {
      (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
    } catch {
      /* 指针已释放则忽略 */
    }
    if (cur) lastSize = cur;
  }

  /** rel 是否落在 DocRenderer 可解析根内（相对路径）；绝对 rel（根外文件）→ 走 /files 原文，避免 404 */
  let relUsable = $derived.by(() => {
    const rel = artifact?.type === "file" ? artifact.rel : undefined;
    return !rel || (rel !== "" && !rel.startsWith("/") && !/^[a-zA-Z]:\//.test(rel));
  });
  let isMd = $derived.by(
    () => artifact?.type === "file" && artifact.kind === "text" && relUsable && /\.md$/i.test(artifact.path),
  );
  let fileUrl = $derived.by(() => {
    if (artifact?.type !== "file") return "";
    return `${API}/files?session=${encodeURIComponent(sessionId ?? "")}&path=${encodeURIComponent(artifact.path)}`;
  });
  let downloadUrl = $derived.by(() => {
    if (artifact?.type !== "file") return "";
    return `${API}/files?session=${encodeURIComponent(sessionId ?? "")}&path=${encodeURIComponent(artifact.path)}&download=1`;
  });
  let docPath = $derived.by(() =>
    artifact?.type === "file" && isMd ? `${artifact.root ?? "project"}:${artifact.rel ?? artifact.path}` : "",
  );

  // 非 md 文本：fetch 原文
  let text = $state("");
  let textErr = $state(false);
  let textLoading = $state(false);
  let textSeq = 0;
  $effect(() => {
    if (artifact?.type === "file" && artifact.kind === "text" && !isMd) {
      const mySeq = ++textSeq;
      text = "";
      textErr = false;
      textLoading = true;
      void (async () => {
        try {
          const r = await fetch(fileUrl);
          if (mySeq !== textSeq) return;
          if (!r.ok) {
            textErr = true;
            textLoading = false;
            return;
          }
          text = await r.text();
          textLoading = false;
        } catch {
          if (mySeq === textSeq) {
            textErr = true;
            textLoading = false;
          }
        }
      })();
    }
  });

  // Office：docx→mammoth->html，xlsx/csv→SheetJS->table；pptx/其它 → 下载兜底
  let officeHtml = $state("");
  let officeErr = $state(false);
  let officeLoading = $state(false);
  let officeSeq = 0;
  $effect(() => {
    if (artifact?.type !== "file" || artifact.kind !== "office") return;
    const mySeq = ++officeSeq;
    officeHtml = "";
    officeErr = false;
    officeLoading = true;
    void (async () => {
      try {
        const r = await fetch(fileUrl);
        if (mySeq !== officeSeq) return;
        if (!r.ok) {
          officeErr = true;
          officeLoading = false;
          return;
        }
        const buf = await r.arrayBuffer();
        const lower = artifact.path.toLowerCase();
        const ext = lower.slice(lower.lastIndexOf(".") + 1);
        let html = "";
        if (ext === "docx") {
          const mod = (await import("mammoth")) as { default?: { convertToHtml: (o: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> }; convertToHtml?: (o: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> };
          const mammoth = mod.default ?? mod;
          const res = await (mammoth.convertToHtml as (o: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>)({ arrayBuffer: buf });
          html = res.value || "";
        } else if (ext === "xlsx" || ext === "xls" || ext === "csv") {
          const mod = (await import("xlsx")) as { default?: { read: (d: unknown, o: { type: string }) => { SheetNames: string[]; Sheets: Record<string, unknown> }; utils: { sheet_to_html: (s: unknown) => string } }; read?: unknown };
          const XLSX = mod.default ?? mod;
          const wb = (XLSX.read as (d: unknown, o: { type: string }) => { SheetNames: string[]; Sheets: Record<string, unknown> })(new Uint8Array(buf), { type: "array" });
          const sheet = wb.Sheets[wb.SheetNames[0]!];
          html = (XLSX.utils.sheet_to_html as (s: unknown) => string)(sheet);
        } else {
          // pptx/odt 等：下载兜底
          officeErr = true;
          officeLoading = false;
          return;
        }
        if (mySeq !== officeSeq) return;
        officeHtml = DOMPurify.sanitize(html);
        officeLoading = false;
      } catch {
        if (mySeq === officeSeq) {
          officeErr = true;
          officeLoading = false;
        }
      }
    })();
  });

  let diffLines = $derived.by(() => (artifact?.type === "diff" ? (artifact.patch || "").split("\n") : []));

  let mediaErr = $state(false);
  $effect(() => {
    void artifact; // 依赖 artifact：切换产物时重置媒体错误态
    mediaErr = false;
  });

  let kindLabel = $derived.by(() => {
    switch (artifact?.type === "file" ? artifact.kind : artifact?.type) {
      case "image":
        return "图片";
      case "video":
        return "视频";
      case "audio":
        return "音频";
      case "pdf":
        return "PDF 文档";
      case "office":
        return "Office 文档";
      case "binary":
        return "二进制文件";
      case "text":
        return isMd ? "Markdown 文档" : "文本文件";
      case "diff":
        return "变更";
      default:
        return "文件";
    }
  });
</script>

{#if artifact}
  <div class="fp-overlay" class:fs={fsMode} role="dialog" aria-modal="true" onclick={onClose}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="fp-card" class:fs={fsMode} style={cardCss} onclick={(e) => e.stopPropagation()}>
      <div class="fp-head">
        <span class="fp-icon">{artifact.type === "file" ? artifactIcon(artifact.kind) : artifact.type === "diff" ? "📝" : "🔗"}</span>
        <span class="fp-title">
          {artifact.type === "file" ? baseName(artifact.path) : artifact.type === "diff" ? baseName(artifact.path) : artifact.url}
        </span>
        <span class="fp-meta">{kindLabel}{artifact.type === "file" ? ` · ${formatBytes(artifact.size)}` : ""}</span>
        <span class="fp-flex"></span>
        {#if artifact.type === "file"}
          <a class="fp-dl" href={downloadUrl} download>下载</a>
        {/if}
        <button
          class="fp-act"
          title={fsMode ? "退出全屏 (Esc)" : "全屏"}
          aria-label={fsMode ? "退出全屏" : "全屏"}
          aria-pressed={fsMode}
          onclick={() => (fsMode = !fsMode)}
        >
          {#if fsMode}
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>
          {:else}
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>
          {/if}
        </button>
        <button class="fp-close" title="关闭 (Esc)" onclick={onClose}>✕</button>
      </div>

      <div class="fp-body" bind:this={bodyEl}>
        {#if artifact.type === "diff"}
          <div class="fp-diff">
            {#each diffLines as l}
              <div class="dl" class:add={l.startsWith("+")} class:del={l.startsWith("-")}>{l}</div>
            {/each}
          </div>
        {:else if artifact.type === "file" && artifact.kind === "text" && isMd}
          <DocRenderer path={docPath} sessionId={sessionId} />
        {:else if artifact.type === "file" && artifact.kind === "text"}
          {#if textErr}
            <div class="fp-err">文本加载失败，请下载查看。</div>
          {:else if textLoading}
            <div class="fp-err">加载中…</div>
          {:else}
            <pre class="fp-code">{text}</pre>
          {/if}
        {:else if artifact.type === "file" && artifact.kind === "image"}
          {#if mediaErr}
            <div class="fp-other">
              <div class="fp-other-ico">⚠️</div>
              <div class="fp-other-txt">媒体加载失败，请下载查看。</div>
              <a class="fp-dl-big" href={downloadUrl} download>下载</a>
            </div>
          {:else}
            <div class="fp-media-center"><img class="fp-img" src={fileUrl} alt={baseName(artifact.path)} onerror={() => (mediaErr = true)} /></div>
          {/if}
        {:else if artifact.type === "file" && artifact.kind === "video"}
          {#if mediaErr}
            <div class="fp-other">
              <div class="fp-other-ico">⚠️</div>
              <div class="fp-other-txt">媒体加载失败，请下载查看。</div>
              <a class="fp-dl-big" href={downloadUrl} download>下载</a>
            </div>
          {:else}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video class="fp-video" controls preload="metadata" src={fileUrl} onerror={() => (mediaErr = true)}></video>
          {/if}
        {:else if artifact.type === "file" && artifact.kind === "audio"}
          {#if mediaErr}
            <div class="fp-other">
              <div class="fp-other-ico">⚠️</div>
              <div class="fp-other-txt">媒体加载失败，请下载查看。</div>
              <a class="fp-dl-big" href={downloadUrl} download>下载</a>
            </div>
          {:else}
            <audio controls preload="metadata" src={fileUrl} onerror={() => (mediaErr = true)}></audio>
          {/if}
        {:else if artifact.type === "file" && artifact.kind === "pdf"}
          <iframe class="fp-pdf" src={fileUrl} title="PDF 预览"></iframe>
        {:else if artifact.type === "file" && artifact.kind === "office"}
          {#if officeErr}
            <div class="fp-other">
              <div class="fp-other-ico">📊</div>
              <div class="fp-other-txt">{kindLabel} 暂不支持内嵌预览，请下载或用默认应用打开。</div>
              <a class="fp-dl-big" href={downloadUrl} download>下载文件</a>
            </div>
          {:else if officeLoading}
            <div class="fp-err">正在转换 Office 文档…</div>
          {:else}
            <div class="fp-office">{@html officeHtml}</div>
          {/if}
        {:else if artifact.type === "file"}
          <div class="fp-other">
            <div class="fp-other-ico">📦</div>
            <div class="fp-other-txt">该类型暂不支持内嵌预览（{kindLabel}）。</div>
            <a class="fp-dl-big" href={downloadUrl} download>下载文件</a>
          </div>
        {:else}
          <div class="fp-other">
            <div class="fp-other-ico">🔗</div>
            <div class="fp-other-txt">链接</div>
            <a class="fp-dl-big" href={artifact.type === "link" ? artifact.url : "#"} target="_blank" rel="noopener noreferrer">打开链接</a>
          </div>
        {/if}
      </div>
      {#if !fsMode}
        <div class="fp-rsz" title="拖拽右下角调整大小" onpointerdown={startResize} onpointermove={moveResize} onpointerup={endResize} onpointercancel={endResize}></div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .fp-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .fp-card {
    position: relative;
    width: min(900px, 94vw);
    height: min(78vh, 640px);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 10px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
  }
  .fp-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
    font-size: 13px;
  }
  .fp-icon { font-size: 16px; }
  .fp-title { font-weight: 600; color: var(--text); word-break: break-all; font-family: var(--font-mono); font-size: 12px; }
  .fp-meta { color: var(--dim); font-size: 11px; white-space: nowrap; }
  .fp-flex { flex: 1; }
  .fp-dl {
    font-size: 11px;
    color: var(--primary);
    text-decoration: none;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .fp-dl:hover { background: var(--primary-light); border-color: var(--primary); }
  .fp-close {
    border: none; background: transparent; color: var(--dim); font-size: 14px;
    cursor: pointer; padding: 2px 6px; border-radius: 6px;
  }
  .fp-close:hover { background: var(--hover-bg); color: var(--text); }
  .fp-body { flex: 1; min-height: 0; overflow: auto; padding: 12px 16px; }
  .fp-card:not(.fs) .fp-body { padding-bottom: 30px; } /* 给右下角拖拽柄让位，避免末行文本被遮 */
  .fp-code {
    font-family: var(--font-mono); font-size: 12px; line-height: 1.6;
    white-space: pre-wrap; word-break: break-all; color: var(--text); margin: 0;
  }
  .fp-diff { font-family: var(--font-mono); font-size: 12px; line-height: 1.7; margin: 0; }
  .dl { white-space: pre-wrap; word-break: break-all; }
  .dl.add { color: var(--success); background: rgba(34, 197, 94, 0.08); }
  .dl.del { color: var(--error); background: rgba(239, 68, 68, 0.08); }
  .dl:not(.add):not(.del) { color: var(--dim); }
  .fp-media-center { display: flex; justify-content: center; }
  .fp-img { max-width: 100%; max-height: 60vh; object-fit: contain; }
  .fp-video { width: 100%; max-height: 60vh; }
  .fp-pdf { width: 100%; height: 100%; min-height: 400px; border: none; }
  .fp-office { font-size: 13px; line-height: 1.7; color: var(--text); }
  .fp-office :global(table) { border-collapse: collapse; margin: 8px 0; max-width: 100%; display: block; overflow-x: auto; }
  .fp-office :global(th), .fp-office :global(td) { border: 1px solid var(--border); padding: 4px 10px; font-size: 12px; }
  .fp-office :global(p), .fp-office :global(li) { margin: 4px 0; }
  .fp-office :global(img) { max-width: 100%; }
  .fp-other { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; height: 100%; color: var(--dim); }
  .fp-other-ico { font-size: 40px; }
  .fp-other-txt { font-size: 12px; text-align: center; max-width: 80%; }
  .fp-dl-big {
    padding: 6px 16px; font-size: 12px; color: #fff; background: var(--primary, #2563eb);
    border-radius: 8px; text-decoration: none;
  }
  .fp-err { color: var(--error); font-size: 12px; padding: 16px; text-align: center; }
  .fp-act {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    color: var(--dim);
    cursor: pointer;
    padding: 3px 6px;
    border-radius: 6px;
  }
  .fp-act:hover { background: var(--hover-bg); color: var(--text); }
  .fp-overlay.fs { padding: 0; background: rgba(0, 0, 0, 0.72); }
  .fp-card.fs { width: 100%; height: 100%; border-radius: 0; }
  .fp-overlay.fs .fp-img { max-height: calc(100dvh - 150px); }
  .fp-overlay.fs .fp-video { max-height: calc(100dvh - 150px); }
  .fp-rsz {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 20px;
    height: 20px;
    cursor: nwse-resize;
    touch-action: none;
    z-index: 5;
  }
  .fp-rsz::after {
    content: "";
    position: absolute;
    right: 4px;
    bottom: 4px;
    width: 7px;
    height: 7px;
    border-right: 2px solid var(--dim);
    border-bottom: 2px solid var(--dim);
    border-bottom-right-radius: 1px;
  }
  .fp-rsz:hover::after { border-color: var(--primary); }
</style>
