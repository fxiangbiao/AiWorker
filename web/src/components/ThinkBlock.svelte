<script lang="ts">
  import { esc } from "$lib/utils/format";

  let { content = "" } = $props();
  let open = $state(false);
</script>

{#if content}
  <div class="think-block" class:open onclick={() => (open = !open)} onkeydown={(e) => e.key === "Enter" && (open = !open)} role="button" tabindex="0">
    <div class="think-toggle">
      <span class="arrow" class:open>&#9654;</span>思考
    </div>
    {#if open}
      <div class="think-body">{esc(content)}</div>
    {/if}
  </div>
{/if}

<style>
  .think-block {
    border-bottom: 1px solid var(--border);
    border-left: 3px solid #5F60F1;
    overflow: hidden;
    background: transparent;
  }
  .think-toggle {
    padding: 10px 18px;
    font-size: 12px;
    color: #5868F0;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 500;
  }
  .arrow { font-size: 10px; transition: transform .2s; }
  .arrow.open { transform: rotate(90deg); }
  .think-body {
    padding: 12px 18px 14px;
    font-size: 12px;
    color: var(--dim);
    border-top: 1px solid var(--border);
    white-space: pre-wrap;
    max-height: 200px;
    overflow-y: auto;
  }
</style>
