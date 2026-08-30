<script lang="ts">
  /**
   * 文档预览面板（Sprint 36）— 右侧面板「文档预览」Tab
   * 文档列表（chips 切换）+ Markdown 渲染（TOC 定位/滚动跟随/图表）
   */
  import { onMount } from "svelte";
  import { X } from "lucide-svelte";
  import { API } from "$lib/stores/chat.svelte";
  import { docViewer } from "$lib/stores/apps.svelte";
  import DocRenderer from "./DocRenderer.svelte";

  let docList = $state<{ path: string; title: string }[]>([]);
  const docPath = $derived($docViewer);

  async function loadDocs() {
    try {
      const r = await fetch(`${API}/docs`);
      if (!r.ok) return;
      const d = (await r.json()) as { docs?: { path: string; title: string; size: number }[] };
      docList = d.docs ?? [];
    } catch {
      /* 忽略 */
    }
  }

  // 文档打开/切换时刷新列表（新生成的文档出现在 chips）
  $effect(() => {
    const p = $docViewer;
    if (p) void loadDocs();
  });

  onMount(() => {
    void loadDocs();
  });
</script>

<div class="dp">
  <div class="dp-head">
    {#if docList.length > 0}
      <div class="dp-chips">
        {#each docList as d (d.path)}
          <button class="apv-chip" class:active={docPath === d.path} onclick={() => docViewer.set(d.path)}>{d.title}</button>
        {/each}
      </div>
    {/if}
    {#if docPath}
      <button class="apv-btn" title="关闭文档" onclick={() => docViewer.set(null)}><X size={12} /></button>
    {/if}
  </div>

  <div class="dp-body">
    {#if docPath}
      <DocRenderer path={docPath} />
    {:else}
      <div class="dp-empty">
        <div>暂无文档</div>
        <span>生成「报告/方案」类内容后自动出现在此处</span>
      </div>
    {/if}
  </div>
</div>

<style>
  .dp { height: 100%; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
  .dp-head { display: flex; align-items: center; gap: 8px; padding: 2px 4px 6px; min-width: 0; }
  .dp-chips { display: flex; gap: 4px; overflow-x: auto; flex: 1; min-width: 0; scrollbar-width: thin; }
  .apv-chip {
    flex-shrink: 0; padding: 3px 8px;
    border: 1px solid var(--border); border-radius: 10px;
    background: var(--surface); color: var(--dim);
    font-size: 11px; cursor: pointer; white-space: nowrap; max-width: 140px; overflow: hidden; text-overflow: ellipsis;
  }
  .apv-chip:hover { border-color: var(--primary); color: var(--primary); }
  .apv-chip.active { background: var(--primary); border-color: var(--primary); color: #fff; }
  .apv-btn {
    width: 24px; height: 24px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface); color: var(--dim); cursor: pointer;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .apv-btn:hover { background: var(--hover-bg); color: var(--primary); }
  .dp-body { flex: 1; min-height: 0; }
  .dp-empty { color: var(--dim); font-size: 12px; text-align: center; padding: 32px 0; line-height: 1.8; }
  .dp-empty > div { font-size: 13px; color: var(--text); font-weight: 600; }
</style>
