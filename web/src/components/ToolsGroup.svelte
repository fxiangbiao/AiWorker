<script lang="ts">
  import ToolCard from "./ToolCard.svelte";
  import { focusToolCallId, type TimelineItem } from "$lib/stores/chat.svelte";

  let { tools, onRetry } = $props<{
    tools: TimelineItem[];
    onRetry?: (tool: TimelineItem) => void;
  }>();
  let open = $state(false);

  // 「在对话中查看」定位到本组内的某张卡片时自动展开（否则卡片不在 DOM 中，无法滚动与高亮）
  $effect(() => {
    const want = $focusToolCallId;
    if (want && tools.some((t: TimelineItem) => t.id === want)) open = true;
  });
</script>

{#if tools.length === 1}
  <ToolCard tool={tools[0]} {onRetry} />
{:else}
  <div class="tools-group" class:open>
    <div class="tools-toggle" onclick={() => (open = !open)} onkeydown={(e) => e.key === "Enter" && (open = !open)} role="button" tabindex="0">
      <span class="arrow" class:open>&#9654;</span>工具调用 ({tools.length})
    </div>
    {#if open}
      <div class="tools-body">
        {#each tools as t}
          <ToolCard tool={t} {onRetry} />
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .tools-group { border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
  .tools-toggle {
    padding: 8px 14px;
    font-size: 11px;
    color: var(--dim);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
    user-select: none;
  }
  .arrow { font-size: 10px; transition: transform .2s; }
  .arrow.open { transform: rotate(90deg); }
  .tools-body { display: none; }
  .tools-group.open .tools-body { display: block; }
</style>
