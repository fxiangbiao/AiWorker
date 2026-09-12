<script lang="ts">
  /**
   * 产物工作台（Sprint 50）— 右栏「产物」Tab
   * 一个数据集（会话产出）+ 两条轴：
   *   空间轴：分组列表（类型/目录/回合）+ 查看器（复用 DocRenderer / DiffView / FilePreview）
   *   时间轴：底部 TimelineStrip（检查点回滚，默认仅代码）
   * 数据源：GET /api/v1/artifacts（服务端合并 工具产物事件 + 快照 diff + 文档索引 + 检查点）
   *         + GET /api/v1/diffs（仅取行级 diff 供 DiffView 渲染，保持载荷小）
   */
  import { API, store, focusToolCallId } from "$lib/stores/chat.svelte";
  import { tick } from "svelte";
  import type { ArtifactItem, ArtifactWorkspace, ArtifactCategory, DiffFileView, GroupMode, TimelineTurn } from "$lib/artifacts";
  import { CATEGORY_LABEL, categoryOf, pathKey, toPreviewArtifact } from "$lib/artifacts";
  import type { ToolArtifact } from "$lib/artifacts";
  import ArtifactList from "./ArtifactList.svelte";
  import ArtifactDetail from "./ArtifactDetail.svelte";
  import TimelineStrip from "./TimelineStrip.svelte";
  import FilePreview from "./FilePreview.svelte";
  import { docViewer } from "$lib/stores/apps.svelte";
  import { RefreshCw } from "lucide-svelte";

  const CATEGORIES: ArtifactCategory[] = ["doc", "code", "image", "media", "link", "other"];
  const DEGRADED_LABEL: Record<string, string> = {
    "early-session": "该会话早于产物记录（Sprint 45 之前），仅显示文件改动与文档",
    "no-rewind": "服务端未启用检查点服务，时间线不可用",
    "no-session-store": "会话存储不可用，仅显示文档索引",
    "tool-artifacts-truncated": "跨会话视图只聚合了最近若干会话的工具产物",
  };

  let workspace = $state<ArtifactWorkspace | null>(null);
  let diffMap = $state<Record<string, DiffFileView>>({});
  let loading = $state(false);
  let error = $state("");
  let category = $state<ArtifactCategory | null>(null);
  let groupMode = $state<GroupMode>("kind");
  let scope = $state<"session" | "all">("session");
  let query = $state("");
  let selectedId = $state<string | null>(null);
  let selectedTurn = $state<number | null>(null);
  let previewArtifact = $state<ToolArtifact | null>(null);
  /** 「在对话中查看」的结果提示：找不到卡片时必须**就地**反馈，不能只写在面板顶部（否则看起来像没反应） */
  let revealNote = $state("");
  /** 定位命中列表（最近优先）与当前下标：支持多命中前后走查 */
  let hits = $state<Array<{ msgIndex: number; callId: string }>>([]);
  let hitIndex = $state(0);
  let focusedEl: HTMLElement | null = null;

  const items = $derived(
    (workspace?.items ?? []).filter((i) => {
      if (category && categoryOf(i) !== category) return false;
      if (query.trim()) {
        const q = query.trim().toLowerCase();
        const hay = `${i.rel ?? ""} ${i.path ?? ""} ${i.title ?? ""} ${i.url ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }),
  );
  const selected = $derived(items.find((i) => i.id === selectedId) ?? null);
  const diffFile = $derived(selected ? diffMap[pathKey(selected.path)] ?? null : null);

  function sessionId(): string {
    return store.activeChatId ?? "";
  }

  async function load(): Promise<void> {
    const id = sessionId();
    if (!id) {
      workspace = null;
      return;
    }
    loading = true;
    error = "";
    try {
      const [arts, diffs] = await Promise.all([
        fetch(`${API}/artifacts?sessionId=${encodeURIComponent(id)}&scope=${scope}`),
        fetch(`${API}/diffs`).catch(() => null),
      ]);
      if (!arts.ok) {
        error = `加载失败（${arts.status}）`;
        workspace = null;
        return;
      }
      workspace = (await arts.json()) as ArtifactWorkspace;
      if (selectedId && !workspace.items.some((i) => i.id === selectedId)) {
        selectedId = null;
      }
      if (diffs && diffs.ok) {
        const data = (await diffs.json()) as { sessions: Array<{ sessionId: string; files: DiffFileView[] }> };
        const map: Record<string, DiffFileView> = {};
        for (const s of data.sessions ?? []) {
          for (const f of s.files ?? []) map[pathKey(f.path)] = f;
        }
        diffMap = map;
      }
    } catch {
      error = "无法连接服务端";
      workspace = null;
    } finally {
      loading = false;
    }
  }

  // 会话切换 → 重新加载并清空选择
  $effect(() => {
    const id = store.activeChatId;
    selectedId = null;
    selectedTurn = null;
    if (id) void load();
  });

  // 生成文档后由 GenCard / apps store 指定要看的文档 → 在产物里选中它
  $effect(() => {
    const want = $docViewer;
    if (!want || !workspace) return;
    const [root, ...rest] = want.split(":");
    const rel = rest.join(":");
    const hit = workspace.items.find((i) => i.root === root && (i.rel ?? "") === rel);
    if (hit) selectedId = hit.id;
  });

  function openPreview(item: ArtifactItem): void {
    const art = toPreviewArtifact(item);
    if (art) previewArtifact = art;
  }

  /** 产物在对话流里的全部命中（**最近优先**）：产物项展示的 turn 是最新回合，故从末尾往前收集 */
  function allHits(item: ArtifactItem): Array<{ msgIndex: number; callId: string }> {
    const key = pathKey(item.path ?? item.url);
    if (!key) return [];
    const hit = (a: ToolArtifact): boolean =>
      a.type === "link" ? pathKey(a.url) === key : pathKey((a as { path?: string }).path) === key;
    const out: Array<{ msgIndex: number; callId: string }> = [];
    for (let i = store.messages.length - 1; i >= 0; i--) {
      const timeline = store.messages[i]?.timeline ?? [];
      for (let k = timeline.length - 1; k >= 0; k--) {
        const t = timeline[k]!;
        if (t.type !== "tool") continue;
        if (!(t.artifacts ?? []).some(hit)) continue;
        // callId 可能缺失（异常数据）→ 仍记录消息下标，定位退化为整条消息
        out.push({ msgIndex: i, callId: typeof t.id === "string" ? t.id : "" });
      }
    }
    return out;
  }

  /**
   * 滚动并高亮第 index 个命中：脉冲一次 + **持久环**（直到切换/清除）
   * 关键：折叠的「工具调用 (N)」分组里卡片不在 DOM 中 → 先置 focusToolCallId 让分组自动展开，
   * 等一帧后再取元素。**取不到具体卡片时只滚动、不加环**（对整条消息加环会框住整个对话区）。
   */
  async function focusHit(index: number): Promise<void> {
    const h = hits[index];
    if (!h) return;
    hitIndex = index;
    if (h.callId) focusToolCallId.set(h.callId);
    await tick();

    const card = h.callId
      ? [...document.querySelectorAll<HTMLElement>("[data-call-id]")].find((el) => el.dataset.callId === h.callId)
      : undefined;
    const msgEl = document.getElementById(`msg-${h.msgIndex}`);
    const target = card ?? msgEl;
    if (!target) {
      revealNote = `对话卡片未渲染（消息 #${h.msgIndex}）`;
      return;
    }
    revealNote = "";
    focusedEl?.classList.remove("artifact-focus", "artifact-pulse");
    target.scrollIntoView({ behavior: "smooth", block: "center" });

    if (!card) {
      // 消息级退化：只滚动定位，不画大框（旧行为会给整条消息描边，视觉上像"框住整个对话区"）
      focusedEl = null;
      revealNote = "已滚动到该消息，但未找到具体工具卡片（该卡片可能未渲染），因此只定位不描边";
      return;
    }

    focusedEl = card;
    card.classList.add("artifact-focus");
    // 重启动画（移除→强制回流→再加），否则连续定位同一元素时脉冲不触发
    card.classList.remove("artifact-pulse");
    void card.offsetWidth;
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) card.classList.add("artifact-pulse");
  }

  function clearFocus(): void {
    focusedEl?.classList.remove("artifact-focus", "artifact-pulse");
    focusedEl = null;
    hits = [];
    hitIndex = 0;
    focusToolCallId.set("");
  }

  function revealInChat(item: ArtifactItem): void {
    if (!item.path && !item.url) {
      revealNote = "该产物没有文件路径或链接，无法定位对话卡片";
      return;
    }
    const found = allHits(item);
    if (found.length === 0) {
      revealNote = "当前对话流里没有产生它的工具卡片（可能是本轮之前写入、已被回滚，或来自其他会话）";
      return;
    }
    hits = found;
    void focusHit(0); // 0 = 最近一次命中
  }

  // Esc 清除高亮（不必回到面板点按钮）
  $effect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && hits.length > 0) clearFocus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const counts = $derived(workspace?.counts);

  // ── 左列表 / 右详情 拖拽调宽（与 App.svelte 右栏 resizer 同一套 pointer 交互） ──
  const MIN_LIST = 140;
  const WIDTH_KEY = "aiworker_artifacts_list_width";
  let listWidth = $state<number | null>(loadListWidth());
  let bodyEl = $state<HTMLElement | null>(null);

  function loadListWidth(): number | null {
    try {
      const raw = localStorage.getItem(WIDTH_KEY);
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) && n >= MIN_LIST ? n : null;
    } catch {
      return null;
    }
  }

  function saveListWidth(w: number): void {
    try {
      localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
    } catch {
      /* 隐私模式等场景静默 */
    }
  }

  function maxListWidth(): number {
    const total = bodyEl?.clientWidth ?? 0;
    return total > 0 ? Math.max(MIN_LIST, total - 220) : 900;
  }

  function clampList(w: number): number {
    return Math.min(Math.max(w, MIN_LIST), maxListWidth());
  }

  function startDrag(e: PointerEvent): void {
    e.preventDefault();
    const startX = e.clientX;
    const startW = listWidth ?? bodyEl?.querySelector<HTMLElement>(".aw-list")?.clientWidth ?? 240;
    const onMove = (ev: PointerEvent) => {
      listWidth = clampList(startW + (ev.clientX - startX));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (listWidth !== null) saveListWidth(listWidth);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function nudgeList(delta: number): void {
    const w = clampList((listWidth ?? 240) + delta);
    listWidth = w;
    saveListWidth(w);
  }

  function resetListWidth(): void {
    listWidth = null;
    try {
      localStorage.removeItem(WIDTH_KEY);
    } catch {
      /* ignore */
    }
  }
</script>

<div class="aw">
  <div class="aw-bar">
    <div class="aw-chips">
      <button class="aw-chip" class:on={category === null} onclick={() => (category = null)}>全部 {counts?.total ?? 0}</button>
      {#each CATEGORIES as c (c)}
        {#if (counts?.byKind && Object.keys(counts.byKind).length > 0) || c === "doc"}
          <button class="aw-chip" class:on={category === c} onclick={() => (category = category === c ? null : c)}>{CATEGORY_LABEL[c]}</button>
        {/if}
      {/each}
    </div>
    <div class="aw-right">
      <select class="aw-sel" bind:value={groupMode} title="分组方式">
        <option value="kind">按类型</option>
        <option value="dir">按目录</option>
        <option value="turn">按回合</option>
      </select>
      <select class="aw-sel" bind:value={scope} onchange={() => void load()} title="范围：本会话 / 所有会话（快照 + 文档）">
        <option value="session">本会话</option>
        <option value="all">所有会话</option>
      </select>
      <input class="aw-search" placeholder="搜索路径/标题" bind:value={query} />
      <button class="aw-refresh" title="刷新产物" onclick={() => void load()} disabled={loading}>
        <span class:spin={loading}><RefreshCw size={13} /></span>
      </button>
    </div>
  </div>

  {#if error}<div class="aw-error">{error}</div>{/if}
  {#if workspace?.degraded?.length}
    <div class="aw-degraded">
      {#each workspace.degraded as d (d)}
        <div>· {DEGRADED_LABEL[d] ?? d}</div>
      {/each}
    </div>
  {/if}
  {#if scope === "all"}
    <div class="aw-note">跨会话视图含各会话的文件改动与文档；工具产物（图片/链接等）来自有改动的最近若干会话</div>
  {/if}

  {#if !sessionId()}
    <div class="aw-empty">当前没有选中的会话</div>
  {:else if loading && !workspace}
    <div class="aw-empty">加载中…</div>
  {:else if (workspace?.items.length ?? 0) === 0}
    <div class="aw-empty">
      本会话还没有产物<br />
      <span class="aw-dim">Agent 写入的文件、生成的文档、图片/音视频与检索链接都会出现在这里</span>
    </div>
  {:else}
    <div class="aw-body" bind:this={bodyEl}>
      <div class="aw-list" style:flex={listWidth ? `0 0 ${listWidth}px` : "0 0 40%"}>
        <ArtifactList {items} mode={groupMode} {selectedId} highlightTurn={selectedTurn} onSelect={(i: ArtifactItem) => { selectedId = i.id; revealNote = ""; clearFocus(); }} />
      </div>
      <button
        class="aw-resizer"
        type="button"
        aria-label="拖拽调整列表宽度（←/→ 微调，Home 或双击复位）"
        title="拖拽调整宽度（双击复位；聚焦后用 ←/→ 微调）"
        onpointerdown={startDrag}
        ondblclick={resetListWidth}
        onkeydown={(e) => {
          if (e.key === "ArrowLeft") { e.preventDefault(); nudgeList(-24); }
          else if (e.key === "ArrowRight") { e.preventDefault(); nudgeList(24); }
          else if (e.key === "Home") { e.preventDefault(); resetListWidth(); }
        }}
      ></button>
      <div class="aw-detail">
        {#if selected}
          <ArtifactDetail
            item={selected}
            sessionId={sessionId() || null}
            {diffFile}
            {revealNote}
            hitsTotal={hits.length}
            {hitIndex}
            onPrevHit={() => void focusHit(hitIndex + 1 < hits.length ? hitIndex + 1 : hitIndex)}
            onNextHit={() => void focusHit(hitIndex > 0 ? hitIndex - 1 : hitIndex)}
            onClearFocus={clearFocus}
            onOpenPreview={openPreview}
            onRevealInChat={revealInChat}
          />
        {:else}
          <div class="aw-empty">从左侧选择一个产物查看</div>
        {/if}
      </div>
    </div>
  {/if}

  <TimelineStrip timeline={(workspace?.timeline ?? []) as TimelineTurn[]} bind:selectedTurn onApplied={() => void load()} />
</div>

{#if previewArtifact}
  <FilePreview sessionId={sessionId() || null} artifact={previewArtifact} onClose={() => (previewArtifact = null)} />
{/if}

<style>
  .aw { display: flex; flex-direction: column; gap: 8px; flex: 1 1 auto; min-height: 0; }
  /* 同 ArtifactDetail：列内只有主体可伸缩，工具条/提示/时间线一律不收缩（避免被"分摊"掉十几 px） */
  .aw > *:not(.aw-body) { flex: 0 0 auto; }
  .aw-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .aw-chips { display: flex; gap: 4px; flex-wrap: wrap; }
  .aw-chip {
    font-size: 10px;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--panel);
    color: var(--dim);
    cursor: pointer;
  }
  .aw-chip.on { border-color: var(--primary); color: var(--primary); background: var(--primary-light); }
  .aw-right { display: flex; align-items: center; gap: 4px; margin-left: auto; }
  .aw-sel, .aw-search {
    font-size: 10px;
    padding: 2px 4px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--panel);
    color: var(--text);
  }
  .aw-search { width: 110px; }
  .aw-refresh { background: none; border: none; color: var(--dim); cursor: pointer; }
  .aw-refresh .spin { display: inline-block; animation: aw-spin 1s linear infinite; }
  @keyframes aw-spin { to { transform: rotate(360deg); } }
  .aw-error { font-size: 11px; color: var(--danger); }
  .aw-degraded { font-size: 10px; color: var(--warning, #d29922); line-height: 1.5; }
  .aw-note, .aw-dim { font-size: 10px; color: var(--dim); }
  .aw-empty { font-size: 11px; color: var(--dim); }
  .aw-body { display: flex; align-items: stretch; gap: 0; flex: 1 1 auto; min-height: 0; }
  .aw-list { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow-y: auto; padding-right: 6px; }
  .aw-resizer {
    flex: 0 0 5px;
    width: 5px;
    padding: 0;
    border: none;
    border-left: 1px solid var(--border);
    cursor: col-resize;
    background: transparent;
    touch-action: none;
  }
  .aw-resizer:hover, .aw-resizer:focus-visible { background: var(--primary-light); outline: none; }
  .aw-detail { min-width: 0; min-height: 0; flex: 1 1 0; display: flex; overflow: hidden; padding-left: 6px; }
</style>
