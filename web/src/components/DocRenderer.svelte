<script lang="ts">
  /**
   * 文档渲染器（Sprint 35）— Markdown 渲染 + 标题目录（点击定位 + 滚动跟随）+ 图表
   * 供右侧「应用预览」面板与文档工作台复用；path 为 "root:相对路径"（root ∈ session|project，无前缀兼容视为 session）
   */
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  import { API } from "$lib/stores/chat.svelte";

  let { path }: { path: string } = $props();

  let content = $state("");
  let html = $state("");
  let chart = $state<{ type: "bar" | "line"; labels: string[]; values: number[] } | null>(null);
  let renderEl = $state<HTMLElement | null>(null);
  let activeHeading = $state("");
  /** 加载序号：快速切换文档时丢弃过期响应，防止内容错乱 */
  let loadSeq = 0;

  /** 解析 root:rel（session 文档支持图表 sidecar；project 文档为纯 Markdown，避免误读项目 data.json） */
  function parseDocKey(p: string): { root: string; rel: string } {
    const idx = p.indexOf(":");
    if (idx > 0 && (p.slice(0, idx) === "session" || p.slice(0, idx) === "project")) {
      return { root: p.slice(0, idx), rel: p.slice(idx + 1) };
    }
    return { root: "session", rel: p };
  }

  $effect(() => {
    if (path) void load(path);
  });

  async function load(p: string) {
    const seq = ++loadSeq;
    content = "";
    html = "";
    chart = null;
    activeHeading = "";
    const { root, rel } = parseDocKey(p);
    try {
      const r = await fetch(`${API}/docs/content?root=${root}&path=${encodeURIComponent(rel)}`);
      if (!r.ok) return;
      const d = (await r.json()) as { content?: string };
      if (seq !== loadSeq) return; // 过期响应丢弃
      content = d.content ?? "";
      html = addHeadingIds(DOMPurify.sanitize(marked.parse(content) as string));
      // 图表 sidecar 仅会话资产（data/docs/）加载：项目目录里的 data.json 可能是业务数据，误读为图表
      if (root === "session" && rel.includes("/")) {
        void loadChart(rel.slice(0, rel.lastIndexOf("/")), seq);
      }
    } catch {
      if (seq === loadSeq) content = "";
    }
  }

  async function loadChart(dir: string, seq: number) {
    chart = null;
    try {
      const r = await fetch(`${API}/docs/content?root=session&path=${encodeURIComponent(dir + "/data.json")}`);
      if (!r.ok) return;
      const d = (await r.json()) as { content?: string };
      if (seq !== loadSeq) return; // 过期响应丢弃
      const c = d.content ? (JSON.parse(d.content) as { chart?: { type?: string; labels?: string[]; values?: number[] } }) : {};
      // 数值必须全部为有限数字（避免 NaN 破坏图表）
      if (
        c.chart &&
        (c.chart.type === "bar" || c.chart.type === "line") &&
        Array.isArray(c.chart.labels) &&
        Array.isArray(c.chart.values) &&
        c.chart.values.every((v) => typeof v === "number" && Number.isFinite(v))
      ) {
        chart = { type: c.chart.type, labels: c.chart.labels, values: c.chart.values };
      }
    } catch {
      /* data.json 不存在或损坏则无图表 */
    }
  }

  /** 给渲染后 HTML 的标题加锚点 id（doc-h-N），供目录定位；先剥离标题自带 id 避免锚点冲突 */
  function addHeadingIds(cleanHtml: string): string {
    let n = 0;
    return cleanHtml
      .replace(/<h([1-4])([^>]*)>/g, (_m, level, attrs) => {
        const clean = String(attrs).replace(/\s+id="[^"]*"/g, "");
        return `<h${level}${clean}>`;
      })
      .replace(/<h([1-4])([^>]*)>([\s\S]*?)<\/h\1>/g, (_m, level, attrs, inner) => {
        n++;
        return `<h${level}${attrs} id="doc-h-${n}">${inner}</h${level}>`;
      });
  }

  /** 目录：从渲染后 HTML 提取标题（id/text/层级，与锚点一致；id 不一定紧跟标签名） */
  function extractHeadings(): { id: string; text: string; level: number }[] {
    const heads: { id: string; text: string; level: number }[] = [];
    for (const m of html.matchAll(/<h([1-4])[^>]*\s+id="(doc-h-\d+)"[^>]*>([\s\S]*?)<\/h\1>/g)) {
      heads.push({ id: m[2]!, text: m[3]!.replace(/<[^>]+>/g, "").trim(), level: Number(m[1]) });
    }
    return heads;
  }

  /** 目录点击 → 渲染区滚动定位到标题 */
  function jumpTo(id: string) {
    activeHeading = id;
    const el = document.getElementById(id);
    if (el && renderEl) {
      const r = renderEl.getBoundingClientRect();
      const e = el.getBoundingClientRect();
      renderEl.scrollTo({ top: renderEl.scrollTop + (e.top - r.top) - 8, behavior: "smooth" });
    }
  }

  /** 滚动跟随：高亮当前可见章节 */
  function onRenderScroll() {
    if (!renderEl) return;
    const marker = renderEl.getBoundingClientRect().top + 16;
    let current = "";
    for (const h of renderEl.querySelectorAll<HTMLElement>("[id^='doc-h-']")) {
      if (h.getBoundingClientRect().top <= marker) current = h.id;
      else break;
    }
    activeHeading = current;
  }
</script>

<div class="dr">
  {#if html}
    <div class="dr-toc">
      {#each extractHeadings() as h (h.id)}
        <button
          class="dr-toc-item"
          class:active={activeHeading === h.id}
          style:padding-left={`${(h.level - 1) * 10}px`}
          title={h.text}
          onclick={() => jumpTo(h.id)}
        >
          {h.text}
        </button>
      {/each}
    </div>
    <div class="dr-render" bind:this={renderEl} onscroll={onRenderScroll} aria-label="文档内容">
      {#if chart}
        <div class="dr-chart">
          {#if chart.type === "bar"}
            <div class="dr-bars">
              {#each chart.labels as label, i (label)}
                <div class="dr-bar-col">
                  <div class="dr-bar" style:height={`${Math.max(2, (chart.values[i] ?? 0) / Math.max(...chart.values, 1) * 120)}px`} title={`${label}: ${chart.values[i]}`}></div>
                  <span class="dr-bar-label">{label}</span>
                </div>
              {/each}
            </div>
          {:else}
            <svg class="dr-line" viewBox="0 0 320 140" preserveAspectRatio="none">
              {#each chart.values as v, i (i)}
                {@const x = (i / Math.max(1, chart.values.length - 1)) * 300 + 10}
                {@const y = 130 - (v / Math.max(...chart.values, 1)) * 110}
                {#if i === 0}
                  <path d={`M ${x} ${y}`} stroke="var(--primary)" stroke-width="2" fill="none" />
                {:else}
                  {@const px = ((i - 1) / Math.max(1, chart.values.length - 1)) * 300 + 10}
                  {@const py = 130 - (chart.values[i - 1]! / Math.max(...chart.values, 1)) * 110}
                  <path d={`M ${px} ${py} L ${x} ${y}`} stroke="var(--primary)" stroke-width="2" fill="none" />
                {/if}
              {/each}
            </svg>
          {/if}
          <div class="dr-chart-labels">
            {#each chart.labels as label, i (label)}
              <span class="dr-chart-v" title={label}>{label}: {chart.values[i]}</span>
            {/each}
          </div>
        </div>
      {/if}
      {@html html}
    </div>
  {:else}
    <div class="dr-empty">加载文档…</div>
  {/if}
</div>

<style>
  .dr { display: flex; height: 100%; gap: 12px; min-height: 0; min-width: 0; }
  .dr-toc {
    width: 130px; flex-shrink: 0; overflow-y: auto;
    font-size: 11px; color: var(--dim); border-right: 1px solid var(--border); padding-right: 8px;
  }
  .dr-toc-item {
    display: block; width: 100%; text-align: left;
    padding: 3px 6px; margin-bottom: 1px;
    border: none; border-radius: 4px;
    background: transparent; color: var(--dim);
    font-family: var(--font-ui); font-size: 11px;
    cursor: pointer; word-break: break-all; line-height: 1.5;
  }
  .dr-toc-item:hover { background: var(--hover-bg); color: var(--text); }
  .dr-toc-item.active { background: var(--primary-light); color: var(--primary); font-weight: 600; }
  .dr-render {
    flex: 1; overflow-y: auto; overflow-x: auto; font-size: 13px; line-height: 1.7; padding: 4px 8px;
    color: var(--text); min-width: 0;
  }
  .dr-chart {
    border: 1px solid var(--border); border-radius: var(--radius-sm);
    padding: 12px; margin-bottom: 12px; background: var(--surface);
  }
  .dr-bars { display: flex; align-items: flex-end; gap: 10px; height: 130px; padding: 0 6px; }
  .dr-bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; height: 100%; justify-content: flex-end; }
  .dr-bar { width: 100%; max-width: 46px; background: var(--primary); border-radius: 4px 4px 0 0; transition: height .3s; }
  .dr-bar-label { font-size: 10px; color: var(--dim); white-space: nowrap; }
  .dr-line { width: 100%; height: 140px; background: var(--bg); border-radius: var(--radius-sm); }
  .dr-chart-labels { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .dr-chart-v { font-size: 10px; color: var(--dim); }
  .dr-render :global(h1) { font-size: 20px; margin: 12px 0 8px; }
  .dr-render :global(h2) { font-size: 16px; margin: 10px 0 6px; }
  .dr-render :global(h3) { font-size: 14px; margin: 8px 0 4px; }
  .dr-render :global(p) { margin: 6px 0; }
  .dr-render :global(ul) { padding-left: 20px; }
  .dr-render :global(table) { border-collapse: collapse; margin: 8px 0; max-width: 100%; display: block; overflow-x: auto; }
  .dr-render :global(th), .dr-render :global(td) { border: 1px solid var(--border); padding: 4px 10px; font-size: 12px; }
  .dr-render :global(code) { background: var(--hover-bg); padding: 1px 5px; border-radius: 4px; font-family: var(--font-mono); font-size: 12px; }
  .dr-empty { color: var(--dim); font-size: 12px; margin: auto; }
</style>
