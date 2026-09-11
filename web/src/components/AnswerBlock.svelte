<script lang="ts">
  import { renderMarkdown } from "$lib/utils/markdown";

  let { content = "", usage = null }: { content?: string; usage?: { prompt?: number; completion?: number; total?: number; contextPct?: number; perTurn?: boolean } | null } = $props();
  let copyLabel = $state("⧉ 复制");

  function handleCopy() {
    const done = () => { copyLabel = "✓ 已复制"; setTimeout(() => (copyLabel = "⧉ 复制"), 1500); };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(content).then(done).catch(() => { fallbackCopy(); done(); });
    } else {
      fallbackCopy();
      done();
    }
  }

  function fallbackCopy() {
    const ta = document.createElement("textarea");
    ta.value = content;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch { /* ignore */ }
    document.body.removeChild(ta);
  }

  function handleCodeCopy(e: MouseEvent) {
    const cp = (e.target as HTMLElement).closest(".copy-btn");
    if (cp) {
      const pre = cp.closest("pre");
      if (pre) {
        navigator.clipboard?.writeText(pre.textContent?.replace(/复制$/, "") ?? "");
      }
    }
  }
</script>

<div class="answer-block">
  <div class="ab-top">
    <span class="ab-label">回答</span>
    <button class="ab-copy" onclick={handleCopy} title="复制原始 Markdown">{copyLabel}</button>
  </div>
  <div class="content" onclick={handleCodeCopy}>
    {@html renderMarkdown(content)}
  </div>
  {#if usage && (usage.total ?? 0) > 0}
    <div class="ab-usage" title="token 用量（估算上下文占比；实时为整轮差分，历史为单次请求）">
      {usage.perTurn === false ? "请求" : "本轮"} ↑{usage.prompt ?? 0} ↓{usage.completion ?? 0} · {usage.total ?? 0} tok
      {#if (usage.contextPct ?? 0) > 0}· 窗口 {usage.contextPct}%（估算）{/if}
    </div>
  {/if}
</div>

<style>
  .answer-block {
    padding: 18px 24px;
    border-top: 1px solid var(--border);
    position: relative;
  }
  .ab-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .ab-label { font-size: 11px; color: var(--dim); }
  .ab-copy {
    background: none;
    border: none;
    color: var(--dim);
    font-family: var(--font-ui);
    font-size: 11px;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 6px;
    user-select: none;
  }
  .ab-copy:hover { color: var(--primary-hover); background: var(--hover-bg); }
  .content { font-size: 14px; line-height: 1.7; color: var(--text); }
  :global(.content p) { margin: 8px 0; }
  :global(.content ul), :global(.content ol) { padding-left: 20px; margin: 8px 0; }
  :global(.content pre) {
    background: var(--hover-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px 16px;
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: 12px;
    position: relative;
    margin: 8px 0;
  }
  :global(.content pre .copy-btn) {
    position: absolute;
    top: 8px;
    right: 8px;
    background: var(--surface);
    color: var(--dim);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 3px 10px;
    font-family: var(--font-ui);
    font-size: 11px;
    cursor: pointer;
  }
  :global(.content pre .copy-btn:hover) { color: var(--text); border-color: var(--primary-hover); }
  :global(.content code) { font-family: var(--font-mono); font-size: 12px; }
  :global(.content :not(pre) > code) {
    background: var(--primary-light);
    color: var(--primary-hover);
    padding: 2px 5px;
    border-radius: 4px;
  }
  :global(.content table) { border-collapse: collapse; width: 100%; margin: 8px 0; }
  :global(.content td), :global(.content th) { border: 1px solid var(--border); padding: 6px 10px; font-size: 12px; }
  :global(.content th) { background: var(--hover-bg); font-weight: 600; }
  .ab-usage {
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px dashed var(--border);
    font-size: 11px;
    color: var(--dim);
    cursor: help;
  }
</style>
