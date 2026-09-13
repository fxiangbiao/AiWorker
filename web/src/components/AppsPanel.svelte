<script lang="ts">
  /**
   * 应用管理面板（Sprint 34）
   * 应用列表（类型/状态/权限）+ 生命周期操作（start/stop/destroy）+ 销毁确认
   */
  import { apps, loadApps, appAction, spawnUpdateCard, openAppInPreview, type AppInfo } from "$lib/stores/apps.svelte";
  import { Play, Square, Trash2, Box, Wrench, BookOpen, UserRound, Server, RefreshCw, Sparkles, PenLine } from "lucide-svelte";
  import ConfirmModal from "./ConfirmModal.svelte";
  import GenWizard from "./GenWizard.svelte";

  let destroyTarget = $state<AppInfo | null>(null);
  let updateTarget = $state<AppInfo | null>(null);
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let notice = $state("");
  let showWizard = $state(false);

  const TYPE_ICON = {
    tool: Wrench,
    skill: BookOpen,
    agent: UserRound,
    service: Server,
    app: Box,
  } as const;

  function statusColor(status: string): string {
    switch (status) {
      case "running":
        return "var(--success)";
      case "starting":
      case "stopping":
        return "var(--warn)";
      case "failed":
        return "var(--error)";
      default:
        return "var(--dim)";
    }
  }

  const STATUS_LABEL: Record<string, string> = {
    installed: "已安装",
    starting: "启动中",
    running: "运行中",
    stopping: "停止中",
    stopped: "已停止",
    failed: "失败",
  };

  async function doAction(a: AppInfo, action: "start" | "stop") {
    busy = a.id;
    error = null;
    const r = await appAction(a.id, action);
    if (!r.ok) error = r.error ?? "操作失败";
    await loadApps();
    busy = null;
  }

  async function confirmDestroy() {
    const target = destroyTarget;
    destroyTarget = null;
    if (!target) return;
    busy = target.id;
    error = null;
    const r = await appAction(target.id, "destroy");
    if (!r.ok) error = r.error ?? "销毁失败";
    await loadApps();
    busy = null;
  }

  /** 迭代更新：提交异步队列，进度/结果以聊天流状态卡片呈现（不再阻塞等待） */
  async function confirmUpdate(target: AppInfo, desc?: string) {
    updateTarget = null;
    if (!desc || !desc.trim()) return;
    error = null;
    notice = "";
    const r = await spawnUpdateCard(target, desc.trim());
    if (!r.ok && !r.jobId) error = r.error ?? "更新提交失败";
  }
</script>

<div class="ap">
  <div class="ap-head">
    <span class="ap-title">应用</span>
    <div class="ap-head-right">
      <button class="ap-gen" title="一句话即时生成应用" onclick={() => (showWizard = true)}><Sparkles size={13} /> 生成</button>
      <button class="ap-refresh" title="刷新" onclick={() => void loadApps()}><RefreshCw size={13} /></button>
    </div>
  </div>

  {#if error}
    <div class="ap-error">{error}</div>
  {/if}
  {#if notice}
    <div class="ap-notice">{notice}</div>
  {/if}

  {#if $apps.length === 0}
    <div class="ap-empty">暂无应用<br /><span>Sprint 35 起可一句话即时生成</span></div>
  {:else}
    <div class="ap-list">
      {#each $apps as a (a.id)}
        {@const Icon = TYPE_ICON[a.type] ?? Box}
        {@const isWebapp = a.type === "app"}
        <div
          class="ap-item"
          class:clickable={isWebapp && a.status === "running"}
          role={isWebapp && a.status === "running" ? "button" : undefined}
          title={isWebapp && a.status === "running" ? "在右侧「应用」面板展示" : undefined}
          onclick={() => {
            // 打开 = 停靠右侧「应用」面板（浮窗/小部件在预览面板内切换）
            if (isWebapp && a.status === "running") openAppInPreview(a.id);
          }}
        >
          <span class="ap-ico" style:color={statusColor(a.status)}><Icon size={15} /></span>
          <div class="ap-body">
            <div class="ap-name">
              {a.name}
              {#if a.plugin}<span class="ap-badge">插件</span>{/if}
              <span class="ap-ver">v{a.version}</span>
            </div>
            <div class="ap-meta">
              <span class="ap-status" style:color={statusColor(a.status)}>{STATUS_LABEL[a.status] ?? a.status}</span>
              {#if a.crashCount}<span class="ap-crash">崩溃 {a.crashCount} 次</span>{/if}
              <span>{a.tools.length > 0 ? `${a.tools.length} 工具` : a.type}</span>
            </div>
            {#if a.lastError}<div class="ap-lasterr">{a.lastError}</div>{/if}
          </div>
          <div class="ap-actions" onclick={(e) => e.stopPropagation()}>
            {#if a.plugin}
              <span class="ap-plugin-tag" title="系统插件由 config/plugins/ 加载，用 /plugins 管理">系统插件</span>
            {:else if a.status === "running" || a.status === "starting"}
              <button class="ap-btn" title="停止" disabled={busy === a.id} onclick={() => void doAction(a, "stop")}><Square size={13} /></button>
            {:else}
              <button class="ap-btn" title="启动" disabled={busy === a.id} onclick={() => void doAction(a, "start")}><Play size={13} /></button>
            {/if}
            {#if !a.plugin && (a.type === "app" || a.type === "tool" || a.type === "service")}
              <button class="ap-btn" title="迭代更新（重写逻辑文件，保留数据）" disabled={busy === a.id} onclick={() => (updateTarget = a)}><PenLine size={13} /></button>
            {/if}
            {#if !a.plugin}
              <button class="ap-btn danger" title="销毁（含数据）" disabled={busy === a.id} onclick={() => (destroyTarget = a)}><Trash2 size={13} /></button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if showWizard}
  <GenWizard onClose={() => (showWizard = false)} />
{/if}

{#if destroyTarget}
  <ConfirmModal
    title="销毁应用"
    message={`确定销毁「${destroyTarget.name}」？将删除其全部代码、数据与权限，不可恢复。`}
    confirmText="销毁"
    danger
    onConfirm={() => void confirmDestroy()}
    onCancel={() => (destroyTarget = null)}
  />
{/if}

{#if updateTarget}
  {@const target = updateTarget}
  <ConfirmModal
    title={`更新应用「${updateTarget.name}」`}
    message="描述本次变更（模型将重写逻辑文件，应用数据保留）。提交后实时进度与结果将显示在对话流中。"
    mode="input"
    inputLabel="变更描述（例：加暂停按钮 / 让宠物自适应窗口）"
    confirmText="更新"
    onConfirm={(v) => void confirmUpdate(target, v)}
    onCancel={() => (updateTarget = null)}
  />
{/if}

<style>
  .ap { display: flex; flex-direction: column; height: 100%; padding: 10px 12px; gap: 8px; overflow-y: auto; }
  .ap-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 6px; }
  .ap-head-right { display: flex; align-items: center; gap: 2px; }
  .ap-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; color: var(--dim); }
  .ap-gen {
    display: flex; align-items: center; gap: 4px; padding: 3px 8px;
    border: 1px solid var(--primary); border-radius: var(--radius-sm);
    background: var(--primary-light); color: var(--primary);
    font-size: 11px; font-weight: 600; cursor: pointer;
  }
  .ap-gen:hover { background: var(--primary); color: #fff; }
  .ap-refresh {
    border: none; background: transparent; color: var(--dim); cursor: pointer;
    display: flex; align-items: center; padding: 3px; border-radius: var(--radius-sm);
  }
  .ap-refresh:hover { background: var(--hover-bg); color: var(--primary); }
  .ap-empty { color: var(--dim); font-size: 12px; text-align: center; padding: 32px 0; line-height: 1.8; }
  .ap-list { display: flex; flex-direction: column; gap: 6px; }
  .ap-item {
    display: flex; gap: 10px; align-items: flex-start;
    padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface);
  }
  .ap-item.clickable { cursor: pointer; transition: border-color .15s, background .15s; }
  .ap-item.clickable:hover { border-color: var(--primary); background: var(--primary-light); }
  .ap-ico { display: flex; align-items: center; padding-top: 1px; }
  .ap-body { flex: 1; min-width: 0; }
  .ap-name { font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .ap-ver { font-size: 11px; color: var(--dim); font-weight: 400; }
  .ap-badge {
    font-size: 10px; color: var(--primary); border: 1px solid var(--primary);
    border-radius: 4px; padding: 0 4px; font-weight: 500;
  }
  .ap-meta { font-size: 11px; color: var(--dim); margin-top: 3px; display: flex; gap: 8px; align-items: center; }
  .ap-crash { color: var(--error); }
  .ap-lasterr { font-size: 11px; color: var(--error); margin-top: 3px; word-break: break-all; }
  .ap-actions { display: flex; gap: 4px; flex-shrink: 0; }
  .ap-btn {
    width: 26px; height: 26px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface); color: var(--dim); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  .ap-btn:hover { background: var(--hover-bg); color: var(--primary); }
  .ap-btn.danger:hover { color: var(--error); border-color: var(--error); }
  .ap-btn:disabled { opacity: .4; cursor: default; }
  .ap-plugin-tag {
    font-size: 10px; color: var(--dim); border: 1px dashed var(--border);
    border-radius: 4px; padding: 3px 6px; white-space: nowrap;
  }
  .ap-error { font-size: 11px; color: var(--error); padding: 4px 8px; background: var(--primary-light); border-radius: var(--radius-sm); }
  .ap-notice { font-size: 11px; color: var(--success); padding: 4px 8px; background: rgba(45, 200, 120, .08); border-radius: var(--radius-sm); }
</style>
