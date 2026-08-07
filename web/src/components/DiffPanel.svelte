<script lang="ts">
  import { basename } from "$lib/utils/format";
  import { store } from "$lib/stores/chat.svelte";
</script>

<div class="rp-section">
  <div class="rp-title">文件变更</div>
  {#if store.diffs.length === 0}
    <div class="empty">暂无变更</div>
  {:else}
    {#each store.diffs as d}
      <div class="diff-file">
        <span class="df-name">{basename(d.filePath)}</span>
        <span class="df-add">+{d.added || 0}</span>
        <span class="df-rem">−{d.removed || 0}</span>
      </div>
    {/each}
  {/if}
</div>

<style>
  .rp-section { margin-bottom: 20px; }
  .rp-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; color: var(--dim); margin-bottom: 8px; }
  .empty { color: var(--dim); font-size: 12px; }
  .diff-file {
    padding: 6px 10px;
    border-radius: 6px;
    margin-bottom: 4px;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    background: var(--bg);
    font-family: var(--font-mono);
    border: 1px solid var(--border);
  }
  .df-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11px; }
  .df-add { color: var(--success); font-weight: 600; }
  .df-rem { color: var(--error); font-weight: 600; }
</style>
