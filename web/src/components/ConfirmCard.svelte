<script lang="ts">
  let { confirm, onRespond } = $props<{
    confirm: {
      id: string;
      title: string;
      message: string;
      options: { value: string; label: string }[];
    };
    onRespond: (value: string | null) => void;
  }>();
</script>

<div class="confirm-card">
  <div class="cc-title">⚠ {confirm.title}</div>
  <div class="cc-message">{confirm.message}</div>
  <div class="cc-options">
    {#each confirm.options as opt}
      <button class="cc-btn" onclick={() => onRespond(opt.value)}>{opt.label}</button>
    {/each}
  </div>
</div>

<style>
  .confirm-card {
    border: 1px solid var(--warn);
    border-radius: var(--radius-sm);
    padding: 12px 16px;
    background: rgba(240, 161, 88, .06);
    margin-bottom: 16px;
  }
  .cc-title { font-size: 12px; font-weight: 600; color: var(--warn); }
  .cc-message { font-size: 12px; color: var(--text); margin: 6px 0 10px; line-height: 1.6; word-break: break-all; }
  .cc-options { display: flex; gap: 8px; }
  .cc-btn {
    padding: 6px 18px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all .15s;
  }
  .cc-btn:hover { background: var(--primary-light); border-color: var(--primary); color: var(--primary); }
</style>
