<script lang="ts">
  import ThinkBlock from "./ThinkBlock.svelte";
  import ToolsGroup from "./ToolsGroup.svelte";
  import AnswerBlock from "./AnswerBlock.svelte";
  import type { UIMessage, TimelineItem } from "$lib/stores/chat.svelte";

  let { msg }: { msg: UIMessage } = $props();
  let timeline = $derived(msg.timeline || []);

  function buildGroups(): Array<{ type: "thinking"; item: TimelineItem } | { type: "tool"; items: TimelineItem[] }> {
    const groups: Array<{ type: "thinking"; item: TimelineItem } | { type: "tool"; items: TimelineItem[] }> = [];
    let i = 0;
    while (i < timeline.length) {
      const t = timeline[i];
      if (t.type === "thinking") {
        groups.push({ type: "thinking", item: t });
        i++;
      } else {
        const tools: TimelineItem[] = [];
        while (i < timeline.length && timeline[i].type === "tool") {
          tools.push(timeline[i]);
          i++;
        }
        groups.push({ type: "tool", items: tools });
      }
    }
    return groups;
  }

  let groups = $derived(buildGroups());
</script>

<div class="msg agent-card">
  {#if groups.length > 0}
    <div class="timeline">
      {#each groups as g}
        {#if g.type === "thinking"}
          <ThinkBlock content={g.item.content || ""} />
        {:else}
          <ToolsGroup tools={g.items} />
        {/if}
      {/each}
    </div>
  {/if}
  {#if msg._thinkingActive}
    <div class="live-label"><span class="spin"></span>思考中...</div>
  {/if}
  {#if msg.content}
    <AnswerBlock content={msg.content} />
  {/if}
</div>

<style>
  .msg { margin-bottom: 24px; }
  .agent-card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  .live-label {
    font-size: 11px;
    color: var(--dim);
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--border);
  }
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
