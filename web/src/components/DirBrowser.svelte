<script lang="ts">
  /**
   * 目录浏览弹窗（Sprint 42 补）— 项目目录选择的数据源为服务端 /dirs（只读列子目录）
   * 浏览器无法取得本机绝对路径（webkitdirectory/File System Access 均不暴露），故用服务端浏览
   */
  import { onMount } from "svelte";
  import { API } from "$lib/stores/chat.svelte";
  import { Folder, FolderUp, CornerDownLeft, X, Loader2 } from "lucide-svelte";

  let {
    initialPath,
    onSelect,
    onClose,
  }: { initialPath: string; onSelect: (p: string) => void; onClose: () => void } = $props();

  let current = $state("");
  let dirs = $state<string[]>([]);
  let parent = $state<string | null>(null);
  let err = $state("");
  let loading = $state(false);
  let jumpInput = $state("");

  async function load(p: string) {
    loading = true;
    err = "";
    try {
      const r = await fetch(`${API}/dirs?path=${encodeURIComponent(p)}`);
      const d = (await r.json()) as { path?: string; dirs?: string[]; parent?: string | null; error?: string };
      if (!r.ok) {
        err = d.error ?? `加载失败（HTTP ${r.status}）`;
        return;
      }
      current = d.path ?? p;
      dirs = d.dirs ?? [];
      parent = d.parent ?? null;
      jumpInput = current;
    } catch (e) {
      err = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  /** 路径分段（可点击跳转；Windows 盘符/Unix 根正确累积） */
  const segments = $derived.by(() => {
    const isWin = /^[a-zA-Z]:/.test(current);
    const sep = isWin ? "\\" : "/";
    const parts = current.split(sep).filter(Boolean);
    const out: { label: string; path: string }[] = [];
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      acc = i === 0 ? (isWin ? parts[0]! : `/${parts[0]!}`) : `${acc}${sep}${parts[i]}`;
      out.push({ label: parts[i]!, path: acc });
    }
    return out;
  });

  function jump() {
    const p = jumpInput.trim();
    if (p) void load(p);
  }

  onMount(() => {
    void load(initialPath || "");
  });
</script>

<div class="dirb-overlay" onclick={(e) => e.target === e.currentTarget && onClose()}>
  <div class="dirb-modal">
    <div class="dirb-head">
      <span class="dirb-title"><Folder size={14} /> 选择项目目录</span>
      <button class="dirb-x" title="关闭" onclick={onClose}><X size={14} /></button>
    </div>

    <div class="dirb-breadcrumb">
      {#each segments as s, i (s.path)}
        {#if i > 0}<span class="dirb-sep">›</span>{/if}
        <button class="dirb-crumb" class:last={i === segments.length - 1} onclick={() => void load(s.path)}>{s.label}</button>
      {/each}
    </div>

    <div class="dirb-jump">
      <input
        class="dirb-input"
        bind:value={jumpInput}
        placeholder="或直接粘贴绝对路径，回车跳转"
        onkeydown={(e) => e.key === "Enter" && jump()}
      />
      <button class="dirb-btn" onclick={jump} title="跳转"><CornerDownLeft size={12} /> 跳转</button>
    </div>

    {#if err}
      <div class="dirb-err">{err}</div>
    {/if}

    <div class="dirb-list">
      {#if parent}
        <button class="dirb-row" onclick={() => void load(parent!)}>
          <FolderUp size={13} class="dirb-ico" />
          <span class="dirb-name">..（上一级）</span>
        </button>
      {/if}
      {#if loading}
        <div class="dirb-empty"><Loader2 size={13} class="dirb-spin" /> 加载中…</div>
      {:else if dirs.length === 0}
        <div class="dirb-empty">（无子目录）</div>
      {:else}
        {#each dirs as d (d)}
          <button class="dirb-row" onclick={() => void load(current.endsWith("/") || current.endsWith("\\") ? current + d : current + (current.includes("\\") ? "\\" : "/") + d)}>
            <Folder size={13} class="dirb-ico" />
            <span class="dirb-name">{d}</span>
          </button>
        {/each}
      {/if}
    </div>

    <div class="dirb-foot">
      <span class="dirb-current" title={current}>{current || "（未选择）"}</span>
      <button class="dirb-btn dirb-primary" onclick={() => onSelect(current)} disabled={!current}>选择此目录</button>
      <button class="dirb-btn" onclick={onClose}>取消</button>
    </div>
  </div>
</div>

<style>
  .dirb-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .dirb-modal {
    width: 560px;
    max-width: 92vw;
    max-height: 76vh;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px;
    box-shadow: var(--shadow);
  }
  .dirb-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .dirb-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .dirb-x {
    border: none;
    background: transparent;
    color: var(--dim);
    cursor: pointer;
    display: flex;
    padding: 4px;
    border-radius: 6px;
  }
  .dirb-x:hover { background: var(--hover-bg); color: var(--text); }
  .dirb-breadcrumb {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px;
    font-size: 12px;
    padding: 6px 8px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .dirb-crumb {
    border: none;
    background: transparent;
    color: var(--primary);
    cursor: pointer;
    font-size: 12px;
    padding: 1px 3px;
    border-radius: 4px;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dirb-crumb:hover { background: var(--hover-bg); }
  .dirb-crumb.last { color: var(--text); cursor: default; }
  .dirb-sep { color: var(--dim); }
  .dirb-jump { display: flex; gap: 6px; }
  .dirb-input {
    flex: 1;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    color: var(--text);
    font-size: 12px;
  }
  .dirb-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
  }
  .dirb-btn:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); }
  .dirb-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .dirb-primary { border-color: var(--primary); background: var(--primary); color: var(--panel); font-weight: 600; }
  .dirb-primary:hover:not(:disabled) { opacity: 0.9; color: var(--panel); }
  .dirb-err { font-size: 11px; color: var(--error); }
  .dirb-list {
    flex: 1;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 160px;
  }
  .dirb-row {
    display: flex;
    align-items: center;
    gap: 8px;
    border: none;
    background: transparent;
    color: var(--text);
    font-size: 12px;
    text-align: left;
    padding: 6px 8px;
    border-radius: 5px;
    cursor: pointer;
  }
  .dirb-row:hover { background: var(--hover-bg); }
  .dirb-ico { color: var(--warn); flex-shrink: 0; }
  .dirb-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dirb-empty {
    color: var(--dim);
    font-size: 12px;
    padding: 14px;
    display: flex;
    align-items: center;
    gap: 6px;
    justify-content: center;
  }
  .dirb-spin { animation: dirb-rotate 0.8s linear infinite; }
  @keyframes dirb-rotate { to { transform: rotate(360deg); } }
  .dirb-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: flex-end;
  }
  .dirb-current {
    flex: 1;
    font-size: 11px;
    color: var(--dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
  }
</style>
