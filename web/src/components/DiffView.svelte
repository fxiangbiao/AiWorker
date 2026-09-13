<script lang="ts">
  /**
   * 行级 diff 渲染（Sprint 50 从原「文件变更」面板抽出，产物面板复用）
   * 只负责渲染：文件信息条 + 行级着色；不再自带文件列表
   */
  import type { DiffFileView } from "$lib/artifacts";
  import { formatBytes } from "$lib/artifacts";

  let { file, onCopyLine }: { file: DiffFileView; onCopyLine?: (line: string) => void } = $props();

  let copied = $state<number | null>(null);

  async function copy(text: string, idx: number): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      copied = idx;
      setTimeout(() => (copied = copied === idx ? null : copied), 1200);
      onCopyLine?.(text);
    } catch {
      /* 剪贴板不可用时静默 */
    }
  }
</script>

<div class="dv">
  {#if file.deleted}
    <div class="dv-note">该文件已被删除，无内容可预览（行级对比见下方变更）</div>
  {:else if file.binary}
    <div class="dv-note">二进制文件，仅显示变更统计（无法行级对比）</div>
  {:else if file.lines.length === 0}
    <div class="dv-note">
      {file.modified ? "该文件由外部工具改动，无行级对比；以下为当前内容" : "无行级差异"}
    </div>
  {/if}

  {#if file.lines.length > 0}
    <pre class="dv-lines">{#each file.lines as ln, i (i)}<div
          class="dv-line {ln.type}"
          title="点击复制该行"
          onclick={() => void copy(ln.text, i)}
          onkeydown={(e) => e.key === "Enter" && void copy(ln.text, i)}
          role="button"
          tabindex="0"
        ><span class="dv-sign">{ln.type === "add" ? "+" : ln.type === "del" ? "-" : " "}</span>{ln.text}{#if copied === i}<span class="dv-copied">已复制</span>{/if}</div>{/each}</pre>
  {:else if file.currentContent}
    <pre class="dv-plain">{file.currentContent}</pre>
  {/if}

  {#if file.currentContent && file.lines.length > 0}
    <details class="dv-cur">
      <summary>查看当前完整内容（{formatBytes(file.currentContent.length)}）</summary>
      <pre class="dv-plain">{file.currentContent}</pre>
    </details>
  {/if}
</div>

<style>
  .dv { display: flex; flex-direction: column; gap: 6px; min-height: 0; }
  .dv-note { font-size: 11px; color: var(--dim); }
  .dv-lines {
    margin: 0;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11.5px;
    line-height: 1.55;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--panel);
  }
  .dv-line { display: block; padding: 0 8px; white-space: pre-wrap; word-break: break-all; cursor: pointer; }
  .dv-line:hover { background: var(--hover-bg); }
  .dv-line.add { background: color-mix(in srgb, var(--success) 12%, transparent); }
  .dv-line.del { background: color-mix(in srgb, var(--danger) 12%, transparent); }
  .dv-sign { display: inline-block; width: 12px; color: var(--dim); user-select: none; }
  .dv-copied { margin-left: 6px; font-size: 10px; color: var(--success); }
  .dv-plain {
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
  .dv-cur summary { font-size: 11px; color: var(--dim); cursor: pointer; }
</style>
