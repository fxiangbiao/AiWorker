<script lang="ts">
  /**
   * 设置 → 工作区（Sprint 50 / IA 重构）
   *
   * 沙箱的三个"根"都在这：`allowDirs`（命令 cwd 根）/ `allowWriteDirs`（写根）/ `allowReadDirs`（读根）。
   * 三者**留空即回退工作目录**——所以每一行都同时显示"配置里写了什么"和"真正生效什么"，
   * 否则用户会以为"空着 = 不限制"（实际是"限制到工作目录"）。
   *
   * 目录一律绝对路径：后端拒绝相对路径（浏览器不知道服务端 cwd，猜出来的范围没有意义）。
   */
  import { onMount } from "svelte";
  import { API } from "$lib/stores/chat.svelte";
  import { workingDir } from "$lib/stores/status";
  import { sandboxState, sandboxError, sandboxNotice, saveSandbox, loadSandbox } from "$lib/stores/settings.svelte";
  import { FolderOpen, Plus, Save } from "lucide-svelte";

  type RootKey = "allowDirs" | "allowWriteDirs" | "allowReadDirs";

  const ROOTS: Array<{ key: RootKey; label: string; hint: string }> = [
    { key: "allowDirs", label: "工作目录根", hint: "约束 terminal_exec 的 cwd：只能在这些目录内执行命令" },
    { key: "allowWriteDirs", label: "可写根", hint: "约束 fs 写入与命令写入目标：只能写到这些目录内" },
    { key: "allowReadDirs", label: "可读根", hint: "约束 fs 读取：只能读这些目录内的文件（受保护路径仍然要确认）" },
  ];

  let draft = $state<Record<RootKey, string[]>>({ allowDirs: [], allowWriteDirs: [], allowReadDirs: [] });
  let dirty = $state(false);
  let busy = $state(false);
  /** 目录选择器：当前浏览的绝对路径与其子目录 */
  let browse = $state<{ open: boolean; key: RootKey | null; path: string; parent: string | null; dirs: string[]; error: string }>({
    open: false,
    key: null,
    path: "",
    parent: null,
    dirs: [],
    error: "",
  });

  $effect(() => {
    const s = $sandboxState;
    if (!s || dirty) return;
    draft = {
      allowDirs: [...s.policy.allowDirs],
      allowWriteDirs: [...s.policy.allowWriteDirs],
      allowReadDirs: [...s.policy.allowReadDirs],
    };
  });

  async function browseTo(path?: string): Promise<void> {
    browse.error = "";
    try {
      const url = path ? `${API}/dirs?path=${encodeURIComponent(path)}` : `${API}/dirs`;
      const resp = await fetch(url);
      if (!resp.ok) {
        browse.error = `读取目录失败（${resp.status}）`;
        return;
      }
      const data = (await resp.json()) as { path: string; parent: string | null; dirs: string[] };
      browse = { ...browse, path: data.path, parent: data.parent, dirs: data.dirs };
    } catch {
      browse.error = "无法连接服务端";
    }
  }

  function openPicker(key: RootKey): void {
    browse = { ...browse, open: true, key };
    void browseTo();
  }

  function pick(): void {
    if (!browse.key) return;
    const key = browse.key;
    if (!draft[key].some((d) => d.toLowerCase() === browse.path.toLowerCase())) {
      draft = { ...draft, [key]: [...draft[key], browse.path] };
      dirty = true;
    }
    browse = { ...browse, open: false, key: null };
  }

  function addManual(key: RootKey): void {
    // 浏览路径为空时不落条目：否则会提交空字符串，被后端以"不允许空条目"拒绝（那是用户看不出原因的失败）
    if (!browse.path) return;
    if (!draft[key].some((d) => d.toLowerCase() === browse.path.toLowerCase())) {
      draft = { ...draft, [key]: [...draft[key], browse.path] };
      dirty = true;
    }
  }

  async function save(): Promise<void> {
    busy = true;
    if (await saveSandbox({ ...draft })) dirty = false;
    busy = false;
  }

  onMount(() => void loadSandbox());
</script>

<div class="sec">
  <div class="sec-block">
    <div class="row">
      <span class="kv">当前工作目录</span>
      <code class="path">{$workingDir || "（未连接）"}</code>
    </div>
    <div class="note">会话的工作目录由启动参数 <code>--dir</code> 决定；空白的沙箱根都会回退到这里。</div>
  </div>

  {#if !$sandboxState}
    <div class="note">{$sandboxError || "正在读取沙箱配置…"}</div>
  {:else}
    {#each ROOTS as r (r.key)}
      <div class="sec-block">
        <div class="sec-title">{r.label}</div>
        <div class="note">{r.hint}</div>
        <div class="chips">
          {#each draft[r.key] as dir (dir)}
            <span class="chip" title={dir}>
              {dir}
              <button class="chip-x" title="移除" onclick={() => { draft = { ...draft, [r.key]: draft[r.key].filter((x) => x !== dir) }; dirty = true; }}>×</button>
            </span>
          {/each}
          {#if draft[r.key].length === 0}
            <span class="note">
              未配置 → 实际生效：{#each $sandboxState.effective[r.key] as e (e)}<code class="path">{e}</code>{/each}
            </span>
          {/if}
        </div>
        <div class="row">
          <button class="btn" onclick={() => openPicker(r.key)}><FolderOpen size={12} /> 选择目录</button>
          <button class="btn" disabled={!browse.path} onclick={() => addManual(r.key)}><Plus size={12} /> 加入当前浏览目录</button>
        </div>
      </div>
    {/each}

    <div class="row">
      <button class="btn primary" disabled={busy || !dirty} onclick={() => void save()}><Save size={12} /> 保存沙箱根</button>
      <span class="note">保存即生效（每次工具调用现读磁盘）；写路径：<code class="path">{$sandboxState.writePath}</code></span>
    </div>
    {#if sandboxNotice}<div class="ok">{$sandboxNotice}</div>{/if}
    {#if $sandboxError}<div class="err">{$sandboxError}</div>{/if}
  {/if}

  {#if browse.open}
    <div class="picker">
      <div class="picker-head">
        <span class="path" title={browse.path}>{browse.path || "…"}</span>
        <button class="btn" onclick={() => (browse = { ...browse, open: false })}>取消</button>
        <button class="btn primary" onclick={pick}>选这个目录</button>
      </div>
      <div class="picker-body">
        {#if browse.parent}<button class="dir up" onclick={() => void browseTo(browse.parent ?? undefined)}>↑ 上一级</button>{/if}
        {#each browse.dirs as d (d)}
          <!-- 用 `/` 拼接：服务端 resolve() 在 Windows 上同样归一化，避免前端写死反斜杠 -->
          <button class="dir" onclick={() => void browseTo(`${browse.path}/${d}`)}>{d}</button>
        {/each}
        {#if browse.dirs.length === 0}<div class="note">（没有子目录）</div>{/if}
      </div>
      {#if browse.error}<div class="err">{browse.error}</div>{/if}
    </div>
  {/if}
</div>

<style>
  .sec { display: flex; flex-direction: column; gap: 12px; }
  .sec-block { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px; }
  .sec-title { font-size: 12px; font-weight: 600; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
  .btn {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 4px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface); color: var(--text); font-size: 12px; cursor: pointer;
  }
  .btn:hover:not(:disabled) { background: var(--hover-bg); }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .btn.primary { border-color: var(--primary); color: var(--primary); }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
  .chip {
    display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
    font-size: 11px; padding: 1px 4px 1px 6px;
    border: 1px solid var(--border); border-radius: 999px; background: var(--panel);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .chip-x { border: none; background: transparent; color: var(--dim); cursor: pointer; font-size: 12px; line-height: 1; padding: 0 2px; }
  .chip-x:hover { color: var(--error); }
  .note { font-size: 11px; color: var(--dim); line-height: 1.55; }
  .ok { font-size: 11px; color: var(--primary); }
  .err { font-size: 11px; color: var(--error); }
  .kv { font-size: 11px; color: var(--dim); border: 1px solid var(--border); border-radius: 3px; padding: 1px 5px; }
  .path { font-family: var(--font-mono); font-size: 10.5px; color: var(--text); word-break: break-all; }
  .picker { border: 1px solid var(--primary); border-radius: var(--radius-sm); overflow: hidden; }
  .picker-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: var(--primary-light); }
  .picker-body { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px; max-height: 200px; overflow-y: auto; }
  .dir {
    font-size: 11px; padding: 2px 8px; border: 1px solid var(--border);
    border-radius: var(--radius-sm); background: var(--surface); color: var(--text); cursor: pointer;
  }
  .dir:hover { background: var(--hover-bg); }
</style>
