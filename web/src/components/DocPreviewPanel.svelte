<script lang="ts">
  /**
   * 文档预览面板（Sprint 36；Sprint 38 支持工作目录项目文档）
   * 右侧面板「文档预览」Tab：会话资产（data/docs/）+ 项目文档（workingDir/）分组 chips + Markdown 渲染
   */
  import { onMount } from "svelte";
  import { X, RefreshCw } from "lucide-svelte";
  import { API } from "$lib/stores/chat.svelte";
  import { docViewer } from "$lib/stores/apps.svelte";
  import { onWsEvent } from "$lib/stores/ws.svelte";
  import DocRenderer from "./DocRenderer.svelte";

  interface DocItem {
    root: "session" | "project";
    path: string;
    title: string;
    size: number;
    mtime: number;
  }
  let docList = $state<DocItem[]>([]);
  let roots = $state<{ root: string; dir: string }[]>([]);
  const docPath = $derived($docViewer);

  async function loadDocs() {
    try {
      const r = await fetch(`${API}/docs`);
      if (!r.ok) return;
      const d = (await r.json()) as { roots?: { root: string; dir: string }[]; docs?: DocItem[] };
      roots = d.roots ?? [];
      docList = d.docs ?? [];
    } catch {
      /* 忽略 */
    }
  }

  const sessionDocs = $derived(docList.filter((d) => d.root === "session"));
  const projectDocs = $derived(docList.filter((d) => d.root === "project"));
  const projectDirName = $derived(roots.find((r) => r.root === "project")?.dir?.split(/[\\/]/).pop() ?? "");
  const docKey = (d: DocItem) => `${d.root}:${d.path}`;

  // 文档打开/切换时刷新列表（新生成的文档出现在 chips）
  $effect(() => {
    const p = $docViewer;
    if (p) void loadDocs();
  });

  onMount(() => {
    void loadDocs();
    // 新文档自动出现：服务端每轮消息后广播 session/update（生成文档 / agent 写入工作目录后触发）
    const off = onWsEvent((data) => {
      if (typeof data?.type === "string" && data.type === "session/update") void loadDocs();
    });
    return off;
  });
</script>

<div class="dp">
  <div class="dp-head">
    <div class="dp-sections">
      {#if sessionDocs.length > 0}
        <div class="dp-sec">会话资产</div>
        <div class="dp-chips">
          {#each sessionDocs as d (docKey(d))}
            <button class="apv-chip" class:active={docPath === docKey(d)} title={d.path} onclick={() => docViewer.set(docKey(d))}>{d.title}</button>
          {/each}
        </div>
      {/if}
      {#if projectDocs.length > 0}
        <div class="dp-sec">项目文档{projectDirName ? ` · ${projectDirName}` : ""}</div>
        <div class="dp-chips">
          {#each projectDocs as d (docKey(d))}
            <button class="apv-chip" class:active={docPath === docKey(d)} title={d.path} onclick={() => docViewer.set(docKey(d))}>{d.path.replace(/\.md$/, "")}</button>
          {/each}
        </div>
      {/if}
    </div>
    <div class="dp-btns">
      <button class="apv-btn" title="刷新文档列表" onclick={() => void loadDocs()}><RefreshCw size={12} /></button>
      {#if docPath}
        <button class="apv-btn" title="关闭文档" onclick={() => docViewer.set(null)}><X size={12} /></button>
      {/if}
    </div>
  </div>

  <div class="dp-body">
    {#if docPath}
      <DocRenderer path={docPath} />
    {:else}
      <div class="dp-empty">
        <div>暂无文档</div>
        <span>生成「报告/方案」或让 AI 在工作目录写 .md 文档后自动出现</span>
      </div>
    {/if}
  </div>
</div>

<style>
  .dp { height: 100%; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
  .dp-head { display: flex; align-items: flex-start; gap: 8px; padding: 2px 4px 6px; min-width: 0; }
  .dp-sections { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .dp-sec {
    font-size: 10px; font-weight: 600; text-transform: uppercase;
    letter-spacing: .4px; color: var(--dim);
  }
  .dp-chips { display: flex; gap: 4px; overflow-x: auto; min-width: 0; scrollbar-width: thin; }
  .dp-btns { display: flex; gap: 4px; flex-shrink: 0; }
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
    display: flex; align-items: center; justify-content: center;
  }
  .apv-btn:hover { background: var(--hover-bg); color: var(--primary); }
  .dp-body { flex: 1; min-height: 0; }
  .dp-empty { color: var(--dim); font-size: 12px; text-align: center; padding: 32px 0; line-height: 1.8; }
  .dp-empty > div { font-size: 13px; color: var(--text); font-weight: 600; }
</style>
