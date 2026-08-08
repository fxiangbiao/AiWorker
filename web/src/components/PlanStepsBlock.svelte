<script lang="ts">
  import type { PlanStep } from "$lib/stores/chat.svelte";

  let { steps, meta }: {
    steps: PlanStep[];
    meta?: { agentA?: string; agentB?: string; failedSteps?: string[] };
  } = $props();

  let open = $state(true);

  const icons: Record<string, string> = {
    pending: "&#9675;",
    running: "&#9681;",
    done: "&#10003;",
    failed: "&#10007;",
    skipped: "&#8213;",
  };
</script>

{#if steps.length > 0}
  <div class="plan-block">
    <div class="plan-toggle" onclick={() => (open = !open)} onkeydown={(e) => e.key === "Enter" && (open = !open)} role="button" tabindex="0">
      <span class="arrow" class:open>&#9654;</span>
      执行步骤 ({steps.length})
    </div>
    {#if open}
      <div class="plan-steps">
        {#each steps as s}
          <div class="p-step" class:running={s.status === "running"} class:done={s.status === "done" || s.status === "skipped"} class:failed={s.status === "failed"}>
            <span class="p-icon">{@html icons[s.status || "pending"]}</span>
            <div class="p-body">
              <div class="p-desc">{s.description}</div>
              <div class="p-meta">
                {s.expertId}
                {#if s.dependsOn.length > 0}· 依赖 {s.dependsOn.join(", ")}{/if}
                {#if s.status === "running"}· 执行中...{/if}
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .plan-block { border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
  .plan-toggle {
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
  .plan-steps { border-top: 1px solid var(--border); padding: 4px 0; }
  .p-step {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 6px 14px;
    font-size: 12px;
    color: var(--dim);
  }
  .p-step.running { background: var(--primary-light); color: var(--primary); }
  .p-step.done { color: var(--dim); }
  .p-step.failed { color: var(--error); }
  .p-icon { width: 14px; font-size: 12px; line-height: 18px; }
  .p-body { flex: 1; }
  .p-desc { font-weight: 500; }
  .p-meta { font-size: 11px; color: var(--dim); margin-top: 1px; }
</style>
