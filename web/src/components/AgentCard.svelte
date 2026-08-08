<script lang="ts">
  import ThinkBlock from "./ThinkBlock.svelte";
  import ToolsGroup from "./ToolsGroup.svelte";
  import AnswerBlock from "./AnswerBlock.svelte";
  import PlanStepsBlock from "./PlanStepsBlock.svelte";
  import type { UIMessage, TimelineItem } from "$lib/stores/chat.svelte";

  let { msg }: { msg: UIMessage } = $props();
  let timeline = $derived(msg.timeline || []);
  let liveLabel = $derived.by(() => {
    if (msg._kind === "plan") {
      return msg._activeStep ? `执行步骤 · ${msg._activeStep}` : "规划中...";
    }
    if (msg._kind === "debate") {
      return msg._activeStep ? `辩论中 · ${msg._activeStep}` : "准备中...";
    }
    return "思考中...";
  });

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

<div class="msg">
  {#if msg._kind === "error"}
    <div class="error-card">⚠ {msg.content}</div>
  {:else}
    <div class="agent-card">
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
        <div class="live-label"><span class="spin"></span>{liveLabel}</div>
      {/if}
      {#if msg._steps && msg._steps.length > 0}
        <PlanStepsBlock steps={msg._steps} meta={msg._meta} />
      {/if}
      {#if msg.content}
        <AnswerBlock content={msg.content} />
      {/if}
    </div>
  {/if}
</div>

<style>
  .msg { margin-bottom: 24px; }
  .error-card {
    border: 1px solid var(--error);
    border-radius: var(--radius);
    background: rgba(232, 84, 107, .06);
    color: var(--error);
    font-size: 12px;
    line-height: 1.6;
    padding: 12px 16px;
    word-break: break-word;
    white-space: pre-wrap;
    margin-bottom: 12px;
  }
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
