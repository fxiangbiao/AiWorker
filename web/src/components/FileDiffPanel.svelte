<script lang="ts">
  import { get } from "svelte/store";
  import { API, store } from "$lib/stores/chat.svelte";
  import { workingDir } from "$lib/stores/status";

  interface DiffLine {
    type: "add" | "del" | "ctx";
    text: string;
  }
  interface DiffFile {
    path: string;
    added: number;
    removed: number;
    lines: DiffLine[];
    /** 无行级 diff（指纹监控）时附带的当前内容全文 */
    currentContent?: string;
    /** 二进制/不可展示内容文件（仅元信息，内容不可预览） */
    binary?: boolean;
    /** 变更前文件已存在但无旧内容（指纹监控），行级 diff 不可得 */
    modified?: boolean;
    /** 文件被删除（指纹反向对比发现） */
    deleted?: boolean;
  }
  interface DiffSession {
    sessionId: string;
    summary?: string | null;
    files: DiffFile[];
    createdAt: number;
    updatedAt: number;
  }

  interface DirNode {
    name: string;
    path: string;
    dirs: DirNode[];
    files: DiffFile[];
  }
  interface TreeRow {
    kind: "dir" | "file";
    name: string;
    path: string;
    depth: number;
    collapsed?: boolean;
    file?: DiffFile;
  }

  let loading = $state(false);
  let sessions: DiffSession[] = $state([]);
  let selected: DiffFile | null = $state(null);
  let listWidth = $state<number | null>(null); // null = 默认 25% (1:3)
  /** 折叠状态：当前会话内折叠的目录路径集合 */
  let collapsedDirs = $state<Set<string>>(new Set());
  /** 最近复制的行号（提示用） */
  let copiedLine = $state<number | null>(null);
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  function startListDrag(e: PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = listWidth ?? 0.25;
    const panelEl = e.currentTarget as HTMLElement;
    const total = panelEl.parentElement?.clientWidth ?? 800;
    const onMove = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
      const ratio = Math.min(Math.max(startW + delta / total, 0.1), 0.5);
      listWidth = ratio;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // 初始加载与后续刷新统一走下方 debounce effect（不再 onMount 直载，避免挂载期双请求）
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  // 注意：effect 内不得读写 $state（如 sessions/selected），否则 load 写回新数组会形成自触发刷新循环
  $effect(() => {
    void store.diffVersion;
    void store.activeChatId; // 切换会话 → 延迟重载（remap 在 load 内完成）
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(load, 400);
  });

  /** 选中文件跟随当前会话：路径不在当前会话 → 选中其第一个文件；无会话 → 清空 */
  function remapSelected() {
    const act = sessions.find((s) => s.sessionId === store.activeChatId) ?? null;
    if (!act) {
      selected = null;
      return;
    }
    if (!selected || !act.files.some((f) => f.path === selected!.path)) {
      selected = act.files[0] ?? null;
    }
  }

  /** 单请求守卫：在途时丢弃重复触发（挂载/切换/流式刷新任何来源最多一次并发） */
  function load() {
    if (inFlight) return;
    inFlight = true;
    loading = true;
    fetch(`${API}/diffs`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        const list: DiffSession[] = (d.sessions || []).sort((a: DiffSession, b: DiffSession) => (b.updatedAt || 0) - (a.updatedAt || 0));
        sessions = list;
        remapSelected();
      })
      .catch(() => {
        sessions = [];
        selected = null;
      })
      .finally(() => {
        inFlight = false;
        loading = false;
      });
  }

  function basename(p: string): string {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }

  /** 以工作目录为根裁剪路径（树根不显示盘符/绝对路径） */
  function displayPath(p: string): string {
    const wd = get(workingDir);
    if (wd) {
      const normWd = wd.replace(/[\\/]+$/, "");
      if (p.startsWith(normWd + "/") || p.startsWith(normWd + "\\")) {
        return p.slice(normWd.length + 1);
      }
      // 大小写不敏感兜底（Windows 盘符大小写差异）
      const lower = p.toLowerCase();
      const lowerWd = normWd.toLowerCase();
      if (lower.startsWith(lowerWd + "/") || lower.startsWith(lowerWd + "\\")) {
        return p.slice(normWd.length + 1);
      }
    }
    return p;
  }

  /** 文件列表 → 目录树（路径以工作目录为根） */
  function buildTree(files: DiffFile[]): DirNode {
    const root: DirNode = { name: "", path: "", dirs: [], files: [] };
    for (const f of files) {
      const rel = displayPath(f.path);
      const parts = rel.split(/[\\/]/);
      const fileName = parts.pop()!;
      let node = root;
      let dirPath = "";
      for (const part of parts) {
        dirPath = dirPath ? `${dirPath}/${part}` : part;
        let child = node.dirs.find((d) => d.name === part);
        if (!child) {
          child = { name: part, path: dirPath, dirs: [], files: [] };
          node.dirs.push(child);
        }
        node = child;
      }
      node.files.push({ ...f, path: f.path });
    }
    return root;
  }

  /** 会话显示名：摘要（标题）优先，回退 sessionId 短形式 */
  function sessionTitle(s: DiffSession): string {
    if (s.summary && s.summary.trim()) return s.summary.trim();
    const local = store.chats.find((c) => c.id === s.sessionId);
    if (local?.title && local.title !== "新对话") return local.title;
    return `${s.sessionId.slice(0, 8)}...`;
  }

  function flattenTree(node: DirNode, depth: number, out: TreeRow[], collapsed: ReadonlySet<string>): void {
    // 目录在前、文件在后，按名称排序
    const dirs = [...node.dirs].sort((a, b) => a.name.localeCompare(b.name));
    const files = [...node.files].sort((a, b) => a.path.localeCompare(b.path));
    for (const d of dirs) {
      const isCollapsed = collapsed.has(d.path);
      out.push({ kind: "dir", name: d.name, path: d.path, depth, collapsed: isCollapsed });
      if (!isCollapsed) flattenTree(d, depth + 1, out, collapsed);
    }
    for (const f of files) {
      out.push({ kind: "file", name: basename(f.path), path: f.path, depth, file: f });
    }
  }

  /** 当前选中会话（跟随 store.activeChatId；无则 null） */
  const activeSession = $derived(sessions.find((s) => s.sessionId === store.activeChatId) ?? null);

  /** 当前会话的树行（$derived 自动追踪 sessions/collapsedDirs/activeChatId 变化） */
  const treeRows = $derived.by(() => {
    if (!activeSession) return [];
    const rows: TreeRow[] = [];
    flattenTree(buildTree(activeSession.files), 0, rows, collapsedDirs);
    return rows;
  });

  function toggleDir(path: string) {
    const next = new Set(collapsedDirs);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    collapsedDirs = next;
  }

  // ── 列表拖拽滚动（按住拖动；>4px 视为滚动，不触发文件选择） ──
  let listEl: HTMLElement | null = null;
  let dragState: { startY: number; startTop: number; dragging: boolean } | null = null;
  let suppressClick = false;

  function onListPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    dragState = { startY: e.clientY, startTop: listEl?.scrollTop ?? 0, dragging: false };
    window.addEventListener("pointermove", onListPointerMove);
    window.addEventListener("pointerup", onListPointerUp);
  }
  function onListPointerMove(e: PointerEvent) {
    if (!dragState || !listEl) return;
    const dy = e.clientY - dragState.startY;
    if (!dragState.dragging && Math.abs(dy) > 4) dragState.dragging = true;
    if (dragState.dragging) {
      listEl.scrollTop = dragState.startTop - dy;
      e.preventDefault();
    }
  }
  function onListPointerUp() {
    // click 在 pointerup 之后同步触发：先记录拖拽标志，下一个宏任务再清空
    suppressClick = dragState?.dragging ?? false;
    dragState = null;
    window.removeEventListener("pointermove", onListPointerMove);
    window.removeEventListener("pointerup", onListPointerUp);
    setTimeout(() => (suppressClick = false), 0);
  }
  function onListClickCapture(e: MouseEvent) {
    // 刚发生过拖拽滚动 → 吞掉本次 click（防止误选文件）
    if (suppressClick) e.stopPropagation();
  }

  /** 点击 diff 行复制该行文本（不含行号/符号）；拖选文本时不触发 */
  function copyLine(line: DiffLine, idx: number) {
    const sel = window.getSelection();
    if (sel && sel.toString().trim()) return; // 正在拖选 → 跳过
    const text = line.text;
    if (!text) return;
    navigator.clipboard?.writeText(text).catch(() => {});
    copiedLine = idx;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copiedLine = null), 1200);
  }
</script>

<div class="diff-body">
  <div class="diff-list" style:width={listWidth ? `${listWidth * 100}%` : "25%"} bind:this={listEl}
    class:dragging={dragState?.dragging}
    onpointerdown={onListPointerDown}
    onpointerup={onListPointerUp}
    onclickcapture={onListClickCapture}>
    <div class="dl-title">{activeSession ? sessionTitle(activeSession) : ""}</div>
    {#if loading && sessions.length === 0}
      <div class="dl-empty">加载中...</div>
    {:else if !activeSession || treeRows.length === 0}
      <div class="dl-empty">当前会话暂无文件变更</div>
    {:else}
      {#each treeRows as row (row.path)}
        {#if row.kind === "dir"}
          <div class="dl-dir" style:padding-left={`${10 + row.depth * 12}px`}
            role="button" tabindex="0"
            onclick={() => toggleDir(row.path)}
            onkeydown={(e) => e.key === "Enter" && toggleDir(row.path)}>
            <span class="dl-caret">{row.collapsed ? "▸" : "▾"}</span>
            <span class="dl-folder">📁</span>
            <span class="dl-dirname">{row.name}</span>
          </div>
        {:else if row.file}
          {@const file = row.file}
          <div
            class="dl-file"
            style:padding-left={`${22 + row.depth * 12}px`}
            class:active={selected?.path === row.file.path}
            title={row.path}
            onclick={() => (selected = file)}
            onkeydown={(e) => e.key === "Enter" && (selected = file)}
            role="button"
            tabindex="0"
          >
            <span class="dl-name" title={row.path}>{row.name}</span>
            {#if row.file.deleted}
              <span class="dl-del">已删除</span>
            {:else if row.file.modified}
              <span class="dl-mod">已修改</span>
            {:else}
              <span class="dl-add">+{row.file.added}</span>
              <span class="dl-rem">-{row.file.removed}</span>
            {/if}
          </div>
        {/if}
      {/each}
    {/if}
  </div>

  <div class="diff-resizer" onpointerdown={startListDrag}></div>

  <div class="diff-detail">
    {#if selected}
      <div class="dd-title">{basename(selected.path)}</div>
      <div class="dd-path">{selected.path}</div>
      {#if selected.deleted}
        <div class="dd-binary">
          <div class="dd-binary-icon">🗑️</div>
          <div class="dd-binary-label">文件已删除</div>
          <div class="dd-binary-hint">内容不可恢复</div>
        </div>
      {:else if selected.currentContent && selected.lines.every((l) => l.type === "ctx")}
        <div class="dd-current-label">当前内容（外部修改，无行级 diff）</div>
        <div class="dd-current">
          {#each selected.currentContent.split("\n") as line, i (i)}
            <div class="dd-curline">
              <span class="dd-no">{i + 1}</span>
              <span class="dd-curtext">{line}</span>
            </div>
          {/each}
        </div>
      {:else if selected.binary}
        <div class="dd-binary">
          <div class="dd-binary-icon">📦</div>
          <div class="dd-binary-label">二进制文件已变更</div>
          <div class="dd-binary-hint">内容不可预览</div>
        </div>
      {:else}
        <div class="dd-lines">
          {#each selected.lines as ln, i (i)}
            <div class="dd-line" class:add={ln.type === "add"} class:del={ln.type === "del"}
              class:copied={copiedLine === i}
              title="点击复制该行"
              onclick={() => copyLine(ln, i)}>
              <span class="dd-no">{i + 1}</span>
              <span class="dd-sign">{ln.type === "add" ? "+" : ln.type === "del" ? "-" : " "}</span>
              <span class="dd-text">{ln.text}</span>
            </div>
          {/each}
        </div>
      {/if}
    {:else}
      <div class="dd-empty">选择左侧文件查看变更</div>
    {/if}
  </div>
</div>

<style>
  .diff-body { display: flex; gap: 8px; flex: 1; min-height: 200px; }
  .diff-list {
    width: 25%;
    overflow-y: auto;
    flex-shrink: 0;
    min-width: 0;
    user-select: none;
    cursor: grab;
  }
  .diff-list.dragging { cursor: grabbing; }
  .diff-resizer {
    width: 5px;
    cursor: col-resize;
    background: transparent;
    flex-shrink: 0;
    transition: background .15s;
  }
  .diff-resizer:hover { background: var(--primary-light); }
  .dl-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--dim);
    margin-bottom: 8px;
    text-transform: uppercase;
    letter-spacing: .5px;
  }
  .dl-empty, .dd-empty { font-size: 12px; color: var(--dim); padding: 16px 0; text-align: center; }
  .dl-caret { width: 10px; flex-shrink: 0; font-size: 9px; }
  .dl-dir {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 11px;
    color: var(--dim);
  }
  .dl-dir:hover { background: var(--hover-bg); color: var(--text); }
  .dl-folder { font-size: 10px; }
  .dl-dirname { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dl-file {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 12px;
    margin-bottom: 3px;
  }
  .dl-file:hover { background: var(--hover-bg); }
  .dl-file.active { background: var(--primary-light); }
  .dl-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dl-add { color: var(--success); font-weight: 600; font-size: 11px; }
  .dl-rem { color: var(--error); font-weight: 600; font-size: 11px; }
  .dl-mod { color: var(--primary); font-weight: 600; font-size: 11px; }
  .dl-del { color: var(--error); font-weight: 600; font-size: 11px; }
  .diff-detail { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
  .dd-title { font-size: 12px; font-weight: 600; word-break: break-all; }
  .dd-path { font-size: 10px; color: var(--dim); margin-bottom: 8px; word-break: break-all; }
  .dd-lines {
    font-family: var(--font-mono);
    font-size: 11px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: auto;
    flex: 1;
  }
  .dd-line { display: flex; gap: 8px; padding: 1px 8px; white-space: pre-wrap; word-break: break-all; cursor: text; }
  .dd-line.add { background: rgba(34, 161, 232, .08); }
  .dd-line.del { background: rgba(232, 84, 107, .08); }
  .dd-line.copied { outline: 1px solid var(--primary); outline-offset: -1px; }
  .dd-no {
    color: var(--dim);
    width: 28px;
    text-align: right;
    flex-shrink: 0;
    user-select: none;
    -webkit-user-select: none;
  }
  .dd-sign {
    width: 12px;
    flex-shrink: 0;
    user-select: none;
    -webkit-user-select: none;
  }
  .dd-line.add .dd-sign { color: var(--success); }
  .dd-line.del .dd-sign { color: var(--error); }
  .dd-text { flex: 1; }
  .dd-current-label { font-size: 11px; font-weight: 600; color: var(--dim); margin-bottom: 4px; }
  .dd-binary {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    color: var(--dim);
  }
  .dd-binary-icon { font-size: 28px; }
  .dd-binary-label { font-size: 13px; font-weight: 600; }
  .dd-binary-hint { font-size: 11px; }
  .dd-current {
    flex: 1;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
  }
  .dd-curline { display: flex; gap: 8px; padding: 1px 8px; white-space: pre-wrap; word-break: break-all; font-family: var(--font-mono); font-size: 11px; color: var(--text); }
  .dd-curtext { flex: 1; }
</style>
