<script lang="ts">
  /**
   * 设置 → 安全（Sprint 50 / IA 重构）
   *
   * 三块内容，按"能不能改、改了以后谁挡着"排列：
   *   ① 权限规则——内嵌既有 PermissionsPanel（唯一实现，不重写）
   *   ② 受保护路径 / 永不自动批准——本轮新增的写面；**草稿用生效清单回填**，
   *      移除内置基线项必须显式勾选确认（后端也会强制要求 acknowledge，前端只是把要求说清楚）
   *   ③ 沙箱强制项（命令黑名单 / 敏感环境变量清理 / 总开关）+ 当前权限模式（只读）
   *
   * 生效时机：规则与清单**立即生效**（写盘后同步更新运行中的 PermissionModel）；
   * 沙箱项同样立即生效（每次工具调用现读磁盘）。
   */
  import { onMount } from "svelte";
  import { API } from "$lib/stores/chat.svelte";
  import { sandboxState, sandboxError, sandboxNotice, saveSandbox } from "$lib/stores/settings.svelte";
  import PermissionsPanel from "../PermissionsPanel.svelte";
  import { AlertTriangle, Plus, Save, ShieldCheck } from "lucide-svelte";

  const TOKEN = typeof window !== "undefined" ? (window.__AIWORKER_TOKEN__ ?? "") : "";

  interface SafetySnapshot {
    mode: string;
    protectedPaths: { fromConfig: string[] | null; defaults: string[]; effective: string[] };
    neverAutoApprove: { fromConfig: string[] | null; effective: string[] };
  }

  let safety = $state<SafetySnapshot | null>(null);
  let safetyError = $state("");
  let safetyNotice = $state("");
  /** 待确认移除的内置基线项（非空时提交需要勾选确认） */
  let pendingRemovals = $state<string[]>([]);
  let acknowledge = $state(false);
  let busy = $state(false);

  let protectedDraft = $state<string[]>([]);
  let protectedInput = $state("");
  let neverDraft = $state<string[]>([]);
  let neverInput = $state("");

  let denyInput = $state("");

  async function loadSafety(): Promise<void> {
    safetyError = "";
    try {
      const resp = await fetch(`${API}/permissions`);
      if (!resp.ok) {
        safety = null;
        safetyError = resp.status === 503 ? "服务端未启用权限记忆" : `加载失败（${resp.status}）`;
        return;
      }
      const data = (await resp.json()) as SafetySnapshot;
      safety = data;
      // 草稿用**生效清单**回填：这样"少写一条"不会静默丢掉内置保护
      protectedDraft = [...data.protectedPaths.effective];
      neverDraft = [...data.neverAutoApprove.effective];
      pendingRemovals = [];
      acknowledge = false;
    } catch {
      safety = null;
      safetyError = "无法连接服务端";
    }
  }

  async function submitSafety(key: "set-protected-paths" | "set-never-auto-approve", values: string[]): Promise<boolean> {
    busy = true;
    safetyError = "";
    safetyNotice = "";
    try {
      const resp = await fetch(`${API}/permissions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-aiworker-token": TOKEN },
        body: JSON.stringify({ action: key, values, acknowledge }),
      });
      const data = (await resp.json()) as { error?: string; warning?: string; removedDefaults?: string[] };
      if (!resp.ok) {
        safetyError = data.error ?? `操作失败（${resp.status}）`;
        if (data.removedDefaults) {
          pendingRemovals = data.removedDefaults;
          acknowledge = false;
        }
        return false;
      }
      safetyNotice = data.warning ?? "已保存并立即生效";
      await loadSafety();
      return true;
    } catch {
      safetyError = "无法连接服务端";
      return false;
    } finally {
      busy = false;
    }
  }

  function addToList(draft: "protected" | "never"): void {
    if (draft === "protected") {
      const v = protectedInput.trim();
      if (v && !protectedDraft.some((d) => d.toLowerCase() === v.toLowerCase())) protectedDraft = [...protectedDraft, v];
      protectedInput = "";
    } else {
      const v = neverInput.trim();
      if (v && !neverDraft.some((d) => d.toLowerCase() === v.toLowerCase())) neverDraft = [...neverDraft, v];
      neverInput = "";
    }
  }

  /** 草稿里相对生效清单少了哪些内置基线项（决定是否需要勾选确认） */
  const removalsInDraft = $derived(
    safety ? safety.protectedPaths.defaults.filter((d) => !protectedDraft.some((p) => p.toLowerCase() === d.toLowerCase())) : [],
  );

  async function saveProtected(): Promise<void> {
    if (removalsInDraft.length > 0 && !acknowledge) {
      pendingRemovals = removalsInDraft;
      safetyError = `本次提交会移除内置基线项（${removalsInDraft.join("、")}），请勾选确认后再保存`;
      return;
    }
    await submitSafety("set-protected-paths", protectedDraft);
  }

  async function addDeny(): Promise<void> {
    const v = denyInput.trim();
    if (!v) return;
    const cur = $sandboxState?.policy.denyCommands ?? [];
    if (cur.some((d) => d.toLowerCase() === v.toLowerCase())) {
      denyInput = "";
      return;
    }
    if (await saveSandbox({ denyCommands: [...cur, v] })) denyInput = "";
  }

  async function removeDeny(cmd: string): Promise<void> {
    const cur = $sandboxState?.policy.denyCommands ?? [];
    await saveSandbox({ denyCommands: cur.filter((c) => c !== cmd) });
  }

  onMount(() => void loadSafety());
</script>

<div class="sec">
  <div class="sec-block">
    <div class="sec-title">权限模式</div>
    <div class="row">
      <span class="tag">{safety?.mode ?? "…"}</span>
      <span class="note">模式在启动时决定（CLI <code>--mode</code> 或配置文件的 <code>default_mode</code>），本页只做展示；运行中切换不在本次范围。</span>
    </div>
  </div>

  <div class="sec-block panel-embed">
    <PermissionsPanel />
  </div>

  <div class="sec-block">
    <div class="sec-title"><ShieldCheck size={13} /> 受保护路径</div>
    <div class="note">
      命中即一律需要确认（<code>allow</code> 规则也不能架空）。清单按**路径段**匹配：写 <code>.git</code> 不会误伤 <code>.gitignore</code>。
    </div>
    {#if safety}
      <div class="chips">
        {#each protectedDraft as p (p)}
          <span class="chip" class:baseline={safety.protectedPaths.defaults.some((d) => d.toLowerCase() === p.toLowerCase())}>
            {p}
            <button class="chip-x" title="移除" onclick={() => (protectedDraft = protectedDraft.filter((x) => x !== p))}>×</button>
          </span>
        {/each}
        {#if protectedDraft.length === 0}<span class="note">（当前清单为空 —— 等于没有任何路径受额外保护）</span>{/if}
      </div>
      <div class="note">带下划线的是内置基线项（配置文件缺失时的兜底清单）。文件里的 <code>protected_paths</code> 是**整体替换**语义，所以移除基线项需显式确认。</div>
      <div class="row">
        <input class="input" bind:value={protectedInput} placeholder="如 secrets 或 .git/config" onkeydown={(e) => e.key === "Enter" && addToList("protected")} />
        <button class="btn" onclick={() => addToList("protected")}><Plus size={12} /> 添加</button>
        <button class="btn primary" disabled={busy} onclick={() => void saveProtected()}><Save size={12} /> 保存</button>
      </div>
      {#if pendingRemovals.length > 0}
        <label class="warn-row">
          <input type="checkbox" bind:checked={acknowledge} />
          我确认要移除内置基线项：{pendingRemovals.join("、")}
        </label>
      {/if}
    {:else}
      <div class="note">{$sandboxError || safetyError || "正在读取…"}</div>
    {/if}
  </div>

  <div class="sec-block">
    <div class="sec-title">永不自动批准</div>
    <div class="note">命中这些工具时，任何模式都要人工确认（<code>allow</code> 规则同样无法架空）。</div>
    <div class="chips">
      {#each neverDraft as n (n)}
        <span class="chip">{n}<button class="chip-x" title="移除" onclick={() => (neverDraft = neverDraft.filter((x) => x !== n))}>×</button></span>
      {/each}
      {#if neverDraft.length === 0}<span class="note">（空清单）</span>{/if}
    </div>
    <div class="row">
      <input class="input" bind:value={neverInput} placeholder="如 terminal_exec 或 mcp_*" onkeydown={(e) => e.key === "Enter" && addToList("never")} />
      <button class="btn" onclick={() => addToList("never")}><Plus size={12} /> 添加</button>
      <button class="btn primary" disabled={busy} onclick={() => void submitSafety("set-never-auto-approve", neverDraft)}><Save size={12} /> 保存</button>
    </div>
  </div>

  <div class="sec-block">
    <div class="sec-title">命令沙箱强制项</div>
    {#if !$sandboxState}
      <div class="note">{$sandboxError || "正在读取…"}</div>
    {:else}
      <label class="row">
        <input type="checkbox" checked={$sandboxState.policy.enabled} onchange={() => void saveSandbox({ enabled: !$sandboxState?.policy.enabled })} />
        启用命令沙箱（关闭只影响命令层；fs 读写边界始终生效）
      </label>
      <label class="row">
        <input type="checkbox" checked={$sandboxState.policy.stripSecretEnv} onchange={() => void saveSandbox({ stripSecretEnv: !$sandboxState?.policy.stripSecretEnv })} />
        子进程剔除敏感环境变量（KEY / TOKEN / SECRET / PASSWORD …）
      </label>
      <div class="sec-sub">命令黑名单（子串匹配）</div>
      <div class="chips">
        {#each $sandboxState.policy.denyCommands as cmd (cmd)}
          <span class="chip">{cmd}<button class="chip-x" title="移除" onclick={() => void removeDeny(cmd)}>×</button></span>
        {/each}
        {#if $sandboxState.policy.denyCommands.length === 0}<span class="note">（空清单）</span>{/if}
      </div>
      <div class="row">
        <input class="input" bind:value={denyInput} placeholder="如 rm -rf / 或 format" onkeydown={(e) => e.key === "Enter" && void addDeny()} />
        <button class="btn" onclick={() => void addDeny()}><Plus size={12} /> 添加</button>
      </div>
      <div class="note">配置文件：{$sandboxState.writePath}（保存即生效，无需重启）</div>
    {/if}
  </div>

  {#if sandboxNotice}<div class="ok">{$sandboxNotice}</div>{/if}
  {#if safetyNotice}<div class="ok">{safetyNotice}</div>{/if}
  {#if safetyError}<div class="err"><AlertTriangle size={12} /> {safetyError}</div>{/if}
  {#if $sandboxError}<div class="err"><AlertTriangle size={12} /> {$sandboxError}</div>{/if}
  <div class="note">优先级 <b>deny &gt; ask &gt; allow</b>；会话级规则重启后失效，项目级规则写入 <code>config/permissions.json</code>。</div>
</div>

<style>
  .sec { display: flex; flex-direction: column; gap: 12px; }
  .sec-block { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px; }
  /* 内嵌既有面板：不允许它自带滚动（否则又是双层滚动），取消它的高度约束 */
  .panel-embed { padding: 0; overflow: hidden; }
  .panel-embed :global(.perms) { height: auto; overflow: visible; }
  .sec-title { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; }
  .sec-sub { font-size: 11px; font-weight: 600; color: var(--dim); }
  .row { display: flex; align-items: center; gap: 8px; font-size: 12px; flex-wrap: wrap; }
  .input { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text); font-size: 12px; padding: 4px 6px; flex: 1 1 160px; min-width: 100px; }
  .btn {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 4px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface); color: var(--text); font-size: 12px; cursor: pointer;
  }
  .btn:hover:not(:disabled) { background: var(--hover-bg); }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .btn.primary { border-color: var(--primary); color: var(--primary); }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .chip {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 11px; padding: 1px 4px 1px 6px;
    border: 1px solid var(--border); border-radius: 999px; background: var(--panel);
  }
  .chip.baseline { border-bottom: 2px solid var(--primary); }
  .chip-x { border: none; background: transparent; color: var(--dim); cursor: pointer; font-size: 12px; line-height: 1; padding: 0 2px; }
  .chip-x:hover { color: var(--error); }
  .note { font-size: 11px; color: var(--dim); line-height: 1.55; }
  .note code { font-family: var(--font-mono); font-size: 10.5px; }
  .tag { font-size: 11px; padding: 1px 6px; border-radius: 999px; background: var(--primary-light); color: var(--primary); }
  .warn-row { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--warning, #d29922); }
  .ok { font-size: 11px; color: var(--primary); }
  .err { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--error); }
</style>
