<script lang="ts">
  /**
   * 文档预览面板（Sprint 36；Sprint 38 支持工作目录项目文档；布局：左侧垂直文档栏）
   * 右侧面板「文档预览」Tab：左栏分组文档列表（会话资产 data/docs/ + 项目文档 workingDir/）＋ 右侧 Markdown 渲染
   */
  import { onMount } from "svelte";
  import { X, RefreshCw, PanelLeftClose, PanelLeftOpen, FileText, FolderOpen } from "lucide-svelte";
  import { API, store } from "$lib/stores/chat.svelte";
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
  /** 文档栏展开/收起（面板窄时收起给渲染区让位） */
  let railOpen = $state(true);
  /** 项目文档树折叠目录（按相对路径） */
  let collapsedDirs = $state<Set<string>>(new Set());
  const docPath = $derived($docViewer);

  async function loadDocs() {
    try {
      // 项目文档根跟随当前会话项目目录（?sessionId=；服务端未设置时回退全局）
      const sid = store.activeChatId;
      const sidParam = sid ? `?sessionId=${encodeURIComponent(sid)}` : "";
      const r = await fetch(`${API}/docs${sidParam}`);
      if (!r.ok) return;
      const d = (await r.json()) as { roots?: { root: string; dir: string }[]; docs?: DocItem[] };
      roots = d.roots ?? [];
      docList = d.docs ?? [];
    } catch {
      /* 忽略 */
    }
  }

  // 切换会话 → 重载文档列表（项目根可能不同）
  $effect(() => {
    void store.activeChatId;
    void loadDocs();
  });

  const sessionDocs = $derived(docList.filter((d) => d.root === "session"));
  const projectDocs = $derived(docList.filter((d) => d.root === "project"));
  const projectDirName = $derived(roots.find((r) => r.root === "project")?.dir?.split(/[\\/]/).pop() ?? "");
  const docKey = (d: DocItem) => `${d.root}:${d.path}`;

  // ── 项目文档文件树（同目录文件聚合，仿「文件变更」左栏） ──
  interface DocTreeNode {
    name: string;
    path: string;
    dirs: Map<string, DocTreeNode>;
    files: { d: DocItem; label: string }[];
  }
  interface DocTreeRow {
    kind: "dir" | "file";
    name: string;
    path: string;
    depth: number;
    /** 仅目录行使用（文件行恒为展开态） */
    collapsed?: boolean;
    d?: DocItem;
  }
  function buildDocTree(items: DocItem[]): DocTreeNode {
    const root: DocTreeNode = { name: "", path: "", dirs: new Map(), files: [] };
    for (const d of items) {
      const parts = d.path.split("/");
      const label = parts.pop()!.replace(/\.md$/, "");
      let node = root;
      let acc = "";
      for (const p of parts) {
        acc = acc ? `${acc}/${p}` : p;
        let child = node.dirs.get(p);
        if (!child) {
          child = { name: p, path: acc, dirs: new Map(), files: [] };
          node.dirs.set(p, child);
        }
        node = child;
      }
      node.files.push({ d, label });
    }
    return root;
  }
  function flattenDocTree(node: DocTreeNode, depth: number, out: DocTreeRow[], collapsed: ReadonlySet<string>): void {
    // 目录在前、文件在后，按名称排序
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    const files = [...node.files].sort((a, b) => a.label.localeCompare(b.label));
    for (const d of dirs) {
      const isCollapsed = collapsed.has(d.path);
      out.push({ kind: "dir", name: d.name, path: d.path, depth, collapsed: isCollapsed });
      if (!isCollapsed) flattenDocTree(d, depth + 1, out, collapsed);
    }
    for (const f of files) {
      out.push({ kind: "file", name: f.label, path: f.d.path, depth, d: f.d });
    }
  }
  const projectRows = $derived.by(() => {
    const rows: DocTreeRow[] = [];
    flattenDocTree(buildDocTree(projectDocs), 0, rows, collapsedDirs);
    return rows;
  });
  function toggleDocDir(path: string) {
    const next = new Set(collapsedDirs);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    collapsedDirs = next;
  }

  // 文档打开/切换时刷新列表（新生成的文档出现在列表）；打开项目文档时自动展开其祖先目录。
  // 注意：此效果读取 collapsedDirs，写入必须仅在真正变化时进行（新 Set 引用会触发依赖失效，
  // 无条件写入会导致 读→写→读… 无限循环，Svelte 抛 effect_update_depth_exceeded）
  $effect(() => {
    const p = $docViewer;
    if (p) {
      void loadDocs();
      if (p.startsWith("project:")) {
        const parts = p.slice("project:".length).split("/");
        parts.pop();
        const next = new Set(collapsedDirs);
        let changed = false;
        let acc = "";
        for (const part of parts) {
          acc = acc ? `${acc}/${part}` : part;
          if (next.delete(acc)) changed = true;
        }
        if (changed) collapsedDirs = next;
      }
    }
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
    {#if docList.length > 0}
      <button class="apv-btn" title={railOpen ? "收起文档栏" : "展开文档栏"} onclick={() => (railOpen = !railOpen)}>
        {#if railOpen}<PanelLeftClose size={12} />{:else}<PanelLeftOpen size={12} />{/if}
      </button>
    {/if}
    {#if docList.length > 0}
      <span class="dp-count">{docList.length} 篇</span>
    {/if}
    <div class="dp-spacer"></div>
    <button class="apv-btn" title="刷新文档列表" onclick={() => void loadDocs()}><RefreshCw size={12} /></button>
    {#if docPath}
      <button class="apv-btn" title="关闭文档" onclick={() => docViewer.set(null)}><X size={12} /></button>
    {/if}
  </div>

  <div class="dp-body">
    {#if docList.length === 0}
      <div class="dp-empty">
        <div>暂无文档</div>
        <span>生成「报告/方案」或让 AI 在工作目录写 .md 文档后自动出现</span>
      </div>
    {:else}
      {#if railOpen}
        <div class="dp-rail">
          {#if sessionDocs.length > 0}
            <div class="dp-sec">会话资产<span class="dp-sec-count">{sessionDocs.length}</span></div>
            <div class="dp-items">
              {#each sessionDocs as d (docKey(d))}
                <button class="dp-item" class:active={docPath === docKey(d)} title={d.path} onclick={() => docViewer.set(docKey(d))}>
                  <FileText size={12} class="dp-item-ico" />
                  <span class="dp-item-label">{d.title}</span>
                </button>
              {/each}
            </div>
          {/if}
          {#if projectDocs.length > 0}
            <div class="dp-sec">项目文档{projectDirName ? ` · ${projectDirName}` : ""}<span class="dp-sec-count">{projectDocs.length}</span></div>
            <div class="dp-items">
              {#each projectRows as row (row.kind === "dir" ? `dir:${row.path}` : `file:${row.path}`)}
                {#if row.kind === "dir"}
                  <button class="dp-item dp-dir" style:padding-left={`${4 + row.depth * 12}px`} onclick={() => toggleDocDir(row.path)}>
                    <span class="dp-caret">{row.collapsed ? "▸" : "▾"}</span>
                    <FolderOpen size={12} class="dp-item-ico" />
                    <span class="dp-item-label">{row.name}</span>
                  </button>
                {:else}
                  {@const d = row.d!}
                  <button
                    class="dp-item"
                    class:active={docPath === docKey(d)}
                    style:padding-left={`${20 + row.depth * 12}px`}
                    title={d.path}
                    onclick={() => docViewer.set(docKey(d))}
                  >
                    <FileText size={12} class="dp-item-ico" />
                    <span class="dp-item-label">{row.name}</span>
                  </button>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      <div class="dp-render">
        {#if docPath}
          <DocRenderer path={docPath} sessionId={store.activeChatId} />
        {:else}
          <div class="dp-render-empty">← 从左侧选择文档预览</div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .dp { height: 100%; display: flex; flex-direction: column; gap: 6px; min-height: 0; min-width: 0; }
  .dp-head { display: flex; align-items: center; gap: 6px; padding: 2px 4px 6px; min-width: 0; }
  .dp-count { font-size: 11px; color: var(--dim); }
  .dp-spacer { flex: 1; }
  .dp-body { flex: 1; min-height: 0; display: flex; gap: 10px; min-width: 0; }
  /* ── 左侧文档栏（垂直列表，IDE 风格） ── */
  .dp-rail {
    width: 172px; flex-shrink: 0; overflow-y: auto;
    border-right: 1px solid var(--border);
    padding-right: 8px;
    display: flex; flex-direction: column; gap: 2px;
  }
  .dp-sec {
    position: sticky; top: 0; z-index: 1;
    display: flex; align-items: center; gap: 6px;
    font-size: 10px; font-weight: 600; text-transform: uppercase;
    letter-spacing: .4px; color: var(--dim);
    padding: 4px 6px 2px;
    background: var(--surface);
  }
  .dp-sec-count {
    font-size: 10px; font-weight: 500; opacity: .65;
    background: var(--hover-bg); border-radius: 8px; padding: 0 5px;
  }
  .dp-items { display: flex; flex-direction: column; gap: 1px; padding: 0 2px 8px; }
  .dp-item { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border: none; border-radius: 6px; background: transparent; color: var(--dim); font-family: var(--font-ui); font-size: 12px; cursor: pointer; text-align: left; min-width: 0; }
  .dp-item-ico { flex-shrink: 0; opacity: .65; }
  .dp-item-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dp-item:hover { background: var(--hover-bg); color: var(--text); }
  .dp-item.active { background: var(--primary-light); color: var(--primary); font-weight: 600; }
  .dp-item.active .dp-item-ico { opacity: 1; }
  .dp-caret { flex-shrink: 0; font-size: 10px; color: var(--dim); width: 10px; }
  .dp-dir { gap: 4px; font-weight: 500; color: var(--text); }
  .dp-dir:hover .dp-caret { color: var(--primary); }
  /* ── 渲染区 ── */
  .dp-render { flex: 1; min-width: 0; min-height: 0; }
  .dp-render-empty { color: var(--dim); font-size: 12px; text-align: center; padding: 32px 0; }
  .dp-empty { color: var(--dim); font-size: 12px; text-align: center; padding: 32px 0; line-height: 1.8; margin: auto; }
  .dp-empty > div { font-size: 13px; color: var(--text); font-weight: 600; }
  .apv-btn {
    width: 24px; height: 24px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface); color: var(--dim); cursor: pointer;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .apv-btn:hover { background: var(--hover-bg); color: var(--primary); }
</style>
