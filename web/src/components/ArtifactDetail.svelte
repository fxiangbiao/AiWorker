<script lang="ts">
  /**
   * 产物详情（Sprint 50）— 右列：元信息 + 动作 + 查看器
   * 查看器分派（复用既有实现，不重造）：
   *   .md → DocRenderer；.html/.htm → HtmlPreview（sandbox iframe）；image → <img>
   *   text → /files 拉原文 <pre>；diff → DiffView；link → 链接卡
   *   video/audio/pdf/office/binary → 打开既有 FilePreview 窗口（含 Office 转换）
   * 档位按 kind 分派（默认档 = 用户最想看的那一档）：
   *   文本/代码（含 md）→ 改动优先（既有裁定）；HTML → 预览优先（源码是次要档）；
   *   图片/媒体 → 内容优先。标签按 kind 取"全文 / 预览 / 图片 / 说明"，不用含糊的"内容"。
   */
  import { API } from "$lib/stores/chat.svelte";
  import type { ArtifactItem, DiffFileView } from "$lib/artifacts";
  import { artifactIcon, baseName, formatBytes, isMarkdown, sourceLabel, toDocKey, toPreviewArtifact } from "$lib/artifacts";
  import DocRenderer from "./DocRenderer.svelte";
  import DiffView from "./DiffView.svelte";
  import HtmlPreview from "./HtmlPreview.svelte";
  import { ExternalLink, Download, Copy, MessageSquare, Eye } from "lucide-svelte";

  let {
    item,
    sessionId,
    diffFile,
    revealNote = "",
    hitsTotal = 0,
    hitIndex = 0,
    onPrevHit,
    onNextHit,
    onClearFocus,
    onOpenPreview,
    onRevealInChat,
  }: {
    item: ArtifactItem;
    sessionId: string | null;
    diffFile: DiffFileView | null;
    /** 「在对话中查看」的就地反馈（找不到卡片时必须有提示，不能静默） */
    revealNote?: string;
    /** 对话流里的命中总数与当前下标（最近一次为 0），用于前后走查 */
    hitsTotal?: number;
    hitIndex?: number;
    onPrevHit?: () => void;
    onNextHit?: () => void;
    onClearFocus?: () => void;
    onOpenPreview: (item: ArtifactItem) => void;
    onRevealInChat: (item: ArtifactItem) => void;
  } = $props();

  let textBody = $state("");
  let textError = $state("");
  let textLoading = $state(false);
  let copied = $state(false);
  let imgError = $state(false);
  /** 手动选档（null = 用该 kind 的默认档）；切换产物时复位，避免上一项的选档串到下一项。
   *  source 只对 HTML 有意义（"预览"与"源码"是同一份内容的两种看法）。 */
  let picked = $state<"content" | "source" | "diff" | null>(null);

  /** HTML 产物：有真实渲染预览（sandbox iframe），源码降为次要档 */
  const isHtml = $derived(item.type === "file" && /\.html?$/i.test(item.path ?? item.rel ?? ""));

  /** 「内容」档的呈现方式（不含改动与源码档） */
  const contentKind = $derived.by(() => {
    if (item.type === "link") return "link" as const;
    if (isHtml) return "html" as const;
    if (isMarkdown(item)) return "markdown" as const;
    if (item.kind === "image") return "image" as const;
    if (item.kind === "text") return "text" as const;
    return "external" as const;
  });

  /** 档位标签：说清"这一档给你什么"，不用含糊的"内容" */
  const contentLabel = $derived(
    isHtml || contentKind === "markdown" ? "预览" : contentKind === "image" ? "图片" : contentKind === "text" ? "全文" : "说明",
  );

  const diffAvailable = $derived(item.type === "diff" || (!!item.hasDiff && !!diffFile && diffFile.lines.length > 0));

  /** 默认档：文本/代码改动优先；HTML 与图片/媒体内容优先 */
  const diffFirst = $derived(item.type === "file" && item.kind === "text" && !isHtml);
  const showDiff = $derived(diffAvailable && (picked === "diff" || (picked === null && diffFirst)));
  const showSource = $derived(picked === "source");
  /** 需要拉 /files 原文：纯文本档，或 HTML 手动切到"全文" */
  const needSource = $derived(showSource || contentKind === "text");
  /** 段控可见性：只有一档时不显示（没有可切换的东西） */
  const toggleVisible = $derived(item.type === "file" && (isHtml || diffAvailable));

  $effect(() => {
    void item.id;
    picked = null;
    imgError = false;
  });

  /** /files 文件 URL（二值/文本预览共用；root+rel 已在产物里算好） */
  function fileUrl(): string {
    if (!item.path) return "";
    const root = item.root ? `&root=${item.root}` : "";
    const sess = sessionId ? `&session=${encodeURIComponent(sessionId)}` : "";
    return `${API}/files?path=${encodeURIComponent(item.path)}${root}${sess}`;
  }

  $effect(() => {
    const need = needSource;
    const current = item;
    textBody = "";
    textError = "";
    if (!need) return;
    textLoading = true;
    const url = `${API}/files?path=${encodeURIComponent(current.path ?? "")}${current.root ? `&root=${current.root}` : ""}${
      sessionId ? `&session=${encodeURIComponent(sessionId)}` : ""
    }`;
    fetch(url)
      .then(async (r) => {
        if (!r.ok) {
          textError = `读取失败（${r.status}）`;
          return;
        }
        textBody = await r.text();
      })
      .catch(() => (textError = "无法连接服务端"))
      .finally(() => (textLoading = false));
  });

  async function copyPath(): Promise<void> {
    try {
      await navigator.clipboard.writeText(item.path ?? item.url ?? "");
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch {
      /* 剪贴板不可用 */
    }
  }
</script>

<div class="ad">
  <div class="ad-head">
    <span class="ad-icon">{item.type === "link" ? "🔗" : artifactIcon(item.kind)}</span>
    <div class="ad-titles">
      <div class="ad-name" title={item.rel ?? item.path ?? item.url}>{item.rel ? baseName(item.rel) : item.title ?? baseName(item.path ?? "")}</div>
      <div class="ad-path" title={item.path ?? item.url}>{item.rel ?? item.path ?? item.url ?? ""}</div>
    </div>
  </div>

  <div class="ad-meta">
    {#if item.size}<span>{formatBytes(item.size)}</span>{/if}
    {#if item.turn}<span>回合 {item.turn}</span>{/if}
    {#if item.tool}<span>{item.tool}</span>{/if}
    {#if item.added || item.removed}<span>+{item.added ?? 0} −{item.removed ?? 0}</span>{/if}
    {#if item.restorable !== undefined}<span>{item.restorable ? "可恢复" : "不可恢复"}</span>{/if}
    {#each item.sources as s (s)}<span class="ad-src">{sourceLabel(s)}</span>{/each}
  </div>

  <div class="ad-actions">
    {#if contentKind === "external" && item.type === "file"}
      <button class="ad-btn" onclick={() => onOpenPreview(item)}><Eye size={11} /> 打开预览</button>
    {/if}
    {#if item.type === "link" && item.url}
      <a class="ad-btn" href={item.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={11} /> 打开链接</a>
    {/if}
    {#if item.type === "file"}
      <a class="ad-btn" href={`${fileUrl()}&download=1`}><Download size={11} /> 下载</a>
      <button class="ad-btn" onclick={() => void copyPath()}><Copy size={11} /> {copied ? "已复制" : "复制路径"}</button>
      <button class="ad-btn" onclick={() => onRevealInChat(item)}><MessageSquare size={11} /> 在对话中查看</button>
    {/if}
  </div>

  {#if revealNote}
    <div class="ad-note ad-warn">{revealNote}</div>
  {:else if hitsTotal > 0}
    <div class="ad-note ad-nav">
      <span>对话中已定位：第 {hitIndex + 1}/{hitsTotal} 处（1 = 最近一次）</span>
      <button class="ad-mini" disabled={hitIndex + 1 >= hitsTotal} onclick={() => onPrevHit?.()} title="更早的命中（逐处往前）">↑ 更早</button>
      <button class="ad-mini" disabled={hitIndex <= 0} onclick={() => onNextHit?.()} title="更近的命中（逐处往后）">↓ 更近</button>
      <button class="ad-mini" onclick={() => onClearFocus?.()} title="清除高亮（Esc）">清除高亮</button>
    </div>
  {/if}
  {#if item.degraded}
    <div class="ad-note">{item.degraded}</div>
  {/if}
  {#if !item.sources.includes("tool") && item.sources.includes("snapshot")}
    <div class="ad-note">来源为工作目录快照：该改动可能不是本会话的 Agent 写入</div>
  {/if}

  {#if toggleVisible}
    <div class="ad-toggle" role="group" aria-label="查看器档位">
      <button class="ad-mini" class:on={!showDiff && !showSource} onclick={() => (picked = "content")}>{contentLabel}</button>
      {#if isHtml}
        <button class="ad-mini" class:on={showSource} onclick={() => (picked = "source")} title="源码全文（HTML 原文）">全文</button>
      {/if}
      {#if diffAvailable}
        <button class="ad-mini" class:on={showDiff} onclick={() => (picked = "diff")} title="源码级改动（快照 diff）">
          改动{#if item.added || item.removed} +{item.added ?? 0} −{item.removed ?? 0}{/if}
        </button>
      {/if}
    </div>
  {/if}

  <div class="ad-viewer">
    {#if item.type === "link"}
      <div class="ad-link">
        {#if item.title}<div class="ad-link-title">{item.title}</div>{/if}
        {#if item.snippet}<div class="ad-link-snippet">{item.snippet}</div>{/if}
      </div>
    {:else if showDiff && diffFile}
      <DiffView file={diffFile} />
    {:else if showSource || contentKind === "text"}
      {#if textLoading}
        <div class="ad-note">加载中…</div>
      {:else if textError}
        <div class="ad-note">{textError}</div>
      {:else}
        <pre class="ad-pre">{textBody}</pre>
      {/if}
    {:else if contentKind === "html"}
      {#if item.change === "deleted"}
        <div class="ad-note">文件已删除，无法预览{diffAvailable ? "（可在「改动」里看它曾经的源码）" : ""}</div>
      {:else}
        <HtmlPreview src={fileUrl()} title={item.rel ?? "HTML 预览"} />
      {/if}
    {:else if contentKind === "markdown" && item.rel}
      <div class="ad-doc">
        <DocRenderer path={toDocKey(item.root, item.rel)} {sessionId} />
      </div>
    {:else if contentKind === "image"}
      {#if item.change === "deleted"}
        <div class="ad-note">文件已删除，无图可预览{diffAvailable ? "（可在「改动」里看它曾经的源码）" : ""}</div>
      {:else if imgError}
        <div class="ad-note">
          图片加载失败（文件可能已删除，或超出预览上限）。
          <a class="ad-inline" href={`${fileUrl()}&download=1`}>下载查看</a>
        </div>
      {:else}
        <img class="ad-img" src={fileUrl()} alt={item.rel ?? "图片"} onerror={() => (imgError = true)} />
      {/if}
    {:else}
      <div class="ad-note">该类型（{item.kind}）在独立预览窗口中查看（支持视频/音频/PDF/Office 转换）</div>
    {/if}
  </div>
</div>

<style>
  .ad { display: flex; flex-direction: column; gap: 6px; flex: 1 1 auto; min-height: 0; min-width: 0; }
  /*
   * 只有查看器可以伸缩：其余行（头部/元信息/动作/提示/档位切换）一律 flex:0 0 auto。
   * 反例：全列默认 flex-shrink:1 时，查看器的 flex-basis:auto 等于其内容高度（可能几千 px），
   * 收缩量按「基准×因子」分摊 → 小行也会被分到十几 px 的收缩。行内文本溢出还看得见，
   * 但 `.ad-toggle` 有 overflow:hidden（为了段控圆角），于是只有它把收缩暴露成"按钮底部被裁"。
   */
  .ad > *:not(.ad-viewer) { flex: 0 0 auto; }
  .ad-head { display: flex; gap: 6px; align-items: center; }
  .ad-icon { font-size: 14px; }
  .ad-titles { min-width: 0; }
  .ad-name { font-size: 12px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ad-path { font-size: 10px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ad-meta { display: flex; flex-wrap: wrap; gap: 6px; font-size: 10px; color: var(--dim); }
  .ad-src { border: 1px solid var(--border); border-radius: 3px; padding: 0 3px; }
  .ad-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .ad-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--panel);
    color: var(--text);
    cursor: pointer;
    text-decoration: none;
  }
  .ad-btn:hover { background: var(--hover-bg); }
  .ad-note { font-size: 11px; color: var(--dim); }
  .ad-warn { color: var(--warning, #d29922); }
  .ad-nav { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  .ad-mini {
    font-size: 10px;
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--panel);
    color: var(--text);
    cursor: pointer;
  }
  .ad-mini:hover:not(:disabled) { background: var(--hover-bg); }
  .ad-mini:disabled { opacity: 0.4; cursor: not-allowed; }
  /* 内容 / 改动 两档切换：段控（选中档主色实底）
   * 三处刻意的写法，避免"下边缘被切"：
   *   ① flex:0 0 auto —— 不被列内收缩分摊（否则与查看器一起被压）；
   *   ② 去掉容器 overflow:hidden，改为给首/末按钮各自圆角 —— 容器不再有任何裁切能力；
   *   ③ 按钮用 inline-flex + align-items:center + 固定 line-height —— 高度由字高确定，不吃行盒的取整误差。
   */
  .ad-toggle { display: inline-flex; align-self: flex-start; flex: 0 0 auto; border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .ad-toggle .ad-mini {
    display: inline-flex;
    align-items: center;
    border: none;
    border-radius: 0;
    padding: 3px 10px;
    line-height: 16px;
    background: var(--panel);
  }
  .ad-toggle .ad-mini:first-child { border-radius: calc(var(--radius-sm) - 1px) 0 0 calc(var(--radius-sm) - 1px); }
  .ad-toggle .ad-mini:last-child { border-radius: 0 calc(var(--radius-sm) - 1px) calc(var(--radius-sm) - 1px) 0; }
  .ad-toggle .ad-mini + .ad-mini { border-left: 1px solid var(--border); }
  .ad-toggle .ad-mini.on { background: var(--primary); color: #fff; }
  .ad-toggle .ad-mini.on:hover { background: var(--primary); }
  .ad-inline { color: var(--primary); text-decoration: underline; }
  .ad-viewer { flex: 1 1 auto; min-height: 0; min-width: 0; overflow: auto; }
  .ad-img { max-width: 100%; max-height: 100%; object-fit: contain; border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .ad-pre {
    margin: 0;
    padding: 8px;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11.5px;
    line-height: 1.55;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    white-space: pre-wrap;
    word-break: break-all;
  }
  .ad-link-title { font-size: 12px; color: var(--text); }
  .ad-link-snippet { font-size: 11px; color: var(--dim); line-height: 1.6; }
  .ad-doc { height: 100%; min-height: 0; overflow: hidden; }
</style>
