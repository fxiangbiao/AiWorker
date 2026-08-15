<script lang="ts">
  import { fmtN, basename } from "$lib/utils/format";
  import { currentModel, totalTokens, workingDir, serverOnline, PRICING } from "$lib/stores/status";

  let cost = $derived((($totalTokens || 0) * (PRICING.prompt + PRICING.completion)) / 1e6);
</script>

<div class="statusbar">
  <div class="sb-item"><span class="sb-dot" class:online={$serverOnline}></span></div>
  <div class="sb-item">model: {$currentModel}</div>
  <div class="sb-item">tokens: {fmtN($totalTokens)}</div>
  <span>cost: ¥{cost.toFixed(4)}</span>
  <span class="sb-dir" title="工作目录: {$workingDir}">💻 {basename($workingDir) || "--"}</span>
</div>

<style>
  .statusbar {
    height: 30px;
    background: var(--surface);
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    padding: 0 16px;
    gap: 20px;
    font-size: 11px;
    color: var(--dim);
    flex-shrink: 0;
  }
  .sb-item { display: flex; align-items: center; gap: 5px; }
  .sb-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); }
  .sb-dot.online { background: var(--success); }
  .sb-dir { max-width: 160px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
