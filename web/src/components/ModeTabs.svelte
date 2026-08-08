<script lang="ts">
  const { mode: current, onSelect } = $props<{ mode: string; onSelect: (m: string) => void }>();
  const modes = ["ask", "plan", "auto"] as const;
</script>

<div class="modes">
  {#each modes as m}
    <button class:active={current === m} onclick={() => onSelect(m)}>
      {m === "ask" ? "Ask" : m === "plan" ? "Plan" : "Auto"}
    </button>
  {/each}
</div>

<style>
  .modes { display: flex; gap: 4px; }
  button {
    padding: 5px 14px;
    border: 1px solid var(--border);
    border-radius: 20px;
    background: transparent;
    color: var(--dim);
    font-family: var(--font-ui);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all .15s;
  }
  button.active { background: var(--primary); color: #fff; border-color: var(--primary); }
  button:hover:not(.active) { background: var(--hover-bg); color: var(--primary-hover); }
</style>
