<script lang="ts">
  import { esc } from "$lib/utils/format";
  import type { TimelineItem } from "$lib/stores/chat.svelte";

  let { tool }: { tool: TimelineItem } = $props();
  let args = $derived.by(() => {
    try {
      return typeof tool.args === "string" ? tool.args : JSON.stringify(tool.args, null, 2);
    } catch {
      return "";
    }
  });
</script>

<div class="tool-card" class:error={!!tool.error}>
  <div class="tc-header">
    <span class="tc-icon">&#9881;</span> {tool.name || "tool"}
  </div>
  <div class="tc-args">{esc(args)}</div>
  {#if tool.pending && !tool.result}
    <div class="tc-result pending"><span class="spin"></span>执行中...</div>
  {:else if tool.error}
    <div class="tc-bubble">
      <span class="tb-title">⚠ 操作被拦截</span>
      <span class="tb-msg">{esc(tool.error)}</span>
    </div>
  {:else if tool.result}
    <div class="tc-result">
      {tool.resultPreview ? esc(tool.resultPreview.slice(0, 200)) : ""}
    </div>
  {/if}
</div>

<style>
  .tool-card {
    border-bottom: 1px solid var(--border);
    padding: 8px 14px;
    background: var(--surface);
  }
  .tool-card:last-child { border-bottom: none; }
  .tc-header {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    font-weight: 500;
    color: var(--dim);
  }
  .tc-icon { font-size: 13px; }
  .tc-args {
    color: var(--dim);
    margin-top: 4px;
    font-size: 12px;
    font-family: var(--font-mono);
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 48px;
    overflow-y: auto;
  }
  .tc-result { margin-top: 6px; font-size: 12px; color: var(--success); font-weight: 500; }
  .tc-result.pending { color: var(--dim); display: flex; align-items: center; gap: 6px; }
  .tc-result.err { color: var(--error); }
  .tc-bubble {
    margin-top: 8px;
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    background: #FEF2F2;
    border: 1px solid #FECACA;
    box-shadow: 0 1px 3px rgba(0, 0, 0, .08);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tb-title { font-size: 12px; font-weight: 600; color: var(--error); }
  .tb-msg { font-size: 11px; color: var(--error); font-family: var(--font-mono); word-break: break-word; white-space: pre-wrap; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spin {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid var(--border);
    border-top-color: var(--primary);
    border-radius: 50%;
    animation: spin .6s linear infinite;
    vertical-align: middle;
  }
</style>
