<script lang="ts">
  import { esc } from "$lib/utils/format";
  import { store } from "$lib/stores/chat.svelte";
  import type { TimelineItem } from "$lib/stores/chat.svelte";
  import type { ToolArtifact } from "$lib/artifacts";
  import { artifactIcon, formatBytes, baseName } from "$lib/artifacts";
  import FilePreview from "./FilePreview.svelte";

  let { tool, onRetry } = $props<{
    tool: TimelineItem;
    onRetry?: (tool: TimelineItem) => void;
  }>();
  let args = $derived.by(() => {
    try {
      return typeof tool.args === "string" ? tool.args : JSON.stringify(tool.args, null, 2);
    } catch {
      return "";
    }
  });
  /** 拦截类错误（安全层拒绝）与执行失败（命令/环境错误）区分 */
  let isBlocked = $derived.by(() => /拦截|禁止|不允许|高危|沙箱/.test(tool.error ?? ""));
  /** 点击预览的产物（file/diff）；link 直接新标签打开不进预览 */
  let preview = $state<ToolArtifact | null>(null);
  let sessionId = $derived.by(() => store.activeChatId);
</script>

<div class="tool-card" class:error={!!tool.error} data-call-id={tool.id}>
  <div class="tc-header">
    <span class="tc-icon">&#9881;</span> {tool.name || "tool"}
  </div>
  <div class="tc-args">{esc(args)}</div>
  {#if tool.pending && !tool.result}
    <div class="tc-result pending"><span class="spin"></span>执行中...</div>
  {:else if tool.error}
    <div class="tc-bubble" class:blocked={isBlocked}>
      <span class="tb-title">{isBlocked ? "⚠ 操作被拦截" : "⚠ 执行失败"}</span>
      <span class="tb-msg">{esc(tool.error)}</span>
      {#if onRetry}
        <button class="tb-retry" onclick={() => onRetry(tool)}>&#8635; {isBlocked ? "调整后重试" : "重试"}</button>
      {/if}
    </div>
  {:else if tool.result}
    <div class="tc-result">
      {tool.resultPreview ? esc(tool.resultPreview.slice(0, 200)) : ""}
    </div>
  {/if}

  {#if tool.artifacts && tool.artifacts.length > 0}
    <div class="tc-artifacts">
      {#each tool.artifacts as a (a.type + (a.type === "link" ? a.url : a.path))}
        {#if a.type === "link"}
          <a class="chip chip-link" href={a.url} target="_blank" rel="noopener noreferrer" title={a.title ?? a.url}>
            🔗 {a.site ?? baseName(a.url)}{a.title ? ` · ${a.title}` : ""}
          </a>
        {:else if a.type === "file"}
          <button class="chip chip-file" onclick={() => (preview = a)} title={a.path}>
            {artifactIcon(a.kind)} {baseName(a.path)}{a.size ? ` · ${formatBytes(a.size)}` : ""}
          </button>
        {:else if a.type === "diff"}
          <button class="chip chip-diff" onclick={() => (preview = a)} title={a.path}>
            📝 变更 {baseName(a.path)}
          </button>
        {/if}
      {/each}
    </div>
  {/if}
</div>

{#if preview}
  <FilePreview {sessionId} artifact={preview} onClose={() => (preview = null)} />
{/if}

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
  .tb-retry {
    margin-top: 6px;
    align-self: flex-start;
    padding: 3px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--primary);
    font-family: var(--font-ui);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
  }
  .tb-retry:hover { background: var(--primary-light); border-color: var(--primary); }
  .tc-artifacts { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    padding: 3px 9px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface);
    cursor: pointer;
    text-decoration: none;
    color: var(--text);
    font-family: var(--font-ui);
    max-width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chip:hover { border-color: var(--primary); background: var(--primary-light); }
  .chip-file { color: var(--primary); }
  .chip-link { color: #0e7490; }
  .chip-diff { color: #b45309; }
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
