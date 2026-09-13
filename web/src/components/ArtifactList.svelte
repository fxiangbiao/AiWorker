<script lang="ts">
  /**
   * 产物分组列表（Sprint 50）— 左列：按 类型/目录/回合 分组，带来源与变更徽标
   */
  import type { ArtifactItem, GroupMode } from "$lib/artifacts";
  import { artifactIcon, baseName, formatBytes, groupArtifacts, sourceLabel } from "$lib/artifacts";

  let {
    items,
    mode,
    selectedId,
    highlightTurn = null,
    onSelect,
  }: {
    items: ArtifactItem[];
    mode: GroupMode;
    selectedId: string | null;
    /** 时间线选中的回合：该回合产物高亮（不隐藏其他，避免"东西不见了"） */
    highlightTurn?: number | null;
    onSelect: (item: ArtifactItem) => void;
  } = $props();

  const groups = $derived(groupArtifacts(items, mode));

  function label(item: ArtifactItem): string {
    if (item.type === "link") return item.title || item.site || item.url || "(链接)";
    return baseName(item.rel ?? item.path ?? "") || item.id;
  }

  function sub(item: ArtifactItem): string {
    if (item.type === "link") return item.site ?? "";
    return item.rel ?? item.path ?? "";
  }
</script>

<div class="al">
  {#if items.length === 0}
    <div class="al-empty">没有匹配的产物</div>
  {:else}
    {#each groups as group (group.key)}
      <div class="al-group">
        <div class="al-group-head">
          <span class="al-group-name">{group.key}</span>
          <span class="al-group-count">{group.items.length}</span>
        </div>
        {#each group.items as item (item.id)}
          <button class="al-item" class:active={selectedId === item.id} class:hl={highlightTurn !== null && item.turn === highlightTurn} title={sub(item)} onclick={() => onSelect(item)}>
            <span class="al-icon">{item.type === "link" ? "🔗" : artifactIcon(item.kind)}</span>
            <span class="al-main">
              <span class="al-name">{label(item)}</span>
              <span class="al-meta">
                {#if item.change}<span class="al-change {item.change}">{item.change === "added" ? "新增" : item.change === "deleted" ? "删除" : "修改"}</span>{/if}
                {#if item.added || item.removed}<span class="al-lines">+{item.added ?? 0} −{item.removed ?? 0}</span>{/if}
                {#if item.turn}<span>回合 {item.turn}</span>{/if}
                {#if item.size}<span>{formatBytes(item.size)}</span>{/if}
                {#if item.sources.includes("snapshot") && !item.sources.includes("tool")}<span class="al-src">快照</span>{/if}
              </span>
            </span>
          </button>
        {/each}
      </div>
    {/each}
  {/if}
</div>

<style>
  .al { display: flex; flex-direction: column; gap: 8px; flex: 1 1 auto; min-height: 0; }
  .al-empty { font-size: 11px; color: var(--dim); }
  .al-group { display: flex; flex-direction: column; gap: 1px; }
  .al-group-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    color: var(--dim);
    text-transform: none;
    padding: 2px 0;
    border-bottom: 1px solid var(--border);
    margin-bottom: 2px;
  }
  .al-group-name { font-weight: 600; }
  .al-group-count { opacity: 0.7; }
  .al-item {
    display: flex;
    gap: 6px;
    align-items: flex-start;
    text-align: left;
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    padding: 3px 6px;
    cursor: pointer;
    color: var(--text);
  }
  .al-item:hover { background: var(--hover-bg); }
  .al-item.hl { box-shadow: inset 2px 0 0 var(--primary); }
  .al-item.active { background: var(--primary-light); border-color: var(--primary); }
  .al-icon { flex: 0 0 auto; font-size: 12px; line-height: 1.4; }
  .al-main { display: flex; flex-direction: column; min-width: 0; }
  .al-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .al-meta { display: flex; flex-wrap: wrap; gap: 6px; font-size: 10px; color: var(--dim); }
  .al-change.added { color: var(--success); }
  .al-change.deleted { color: var(--danger); }
  .al-change.modified { color: var(--warning, #d29922); }
  .al-lines { font-family: var(--font-mono, ui-monospace, monospace); }
  .al-src { border: 1px solid var(--border); border-radius: 3px; padding: 0 3px; }
</style>
