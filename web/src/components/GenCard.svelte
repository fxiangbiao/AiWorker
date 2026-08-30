<script lang="ts">
  /**
   * 生成任务状态卡片（Sprint 36「应用工坊」）
   * 渲染一条 _kind:"gen" 的 assistant 消息：状态经 genJobs store（WS gen/* 事件）实时刷新
   * 完成态提供「打开应用/查看文档」入口（右侧面板联动）
   */
  import {
    genJobs,
    cancelGenerate,
    openAppInPreview,
    docViewer,
    rightTab,
    rightPanelVisible,
    type GenJobState,
  } from "$lib/stores/apps.svelte";
  import type { UIMessage } from "$lib/stores/chat.svelte";
  import { Sparkles, Loader2 } from "lucide-svelte";

  let { msg }: { msg: UIMessage } = $props();

  /** 更新 vs 生成：决定文案与结果展示（卡片消息带 _genAction，刷新后仍可区分） */
  const isUpdate = $derived(msg._genAction === "update");

  // 优先实时 genJobs（进行中进度）；无实时数据时回退到持久化终态（刷新/重开会话后仍展示）
  const job = $derived(
    (msg._genJobId ? $genJobs[msg._genJobId] : undefined) ??
      (msg._genStatus
        ? ({
            status: msg._genStatus,
            result: msg._genResult ? { ok: true, app: msg._genResult.app, docPath: msg._genResult.docPath } : undefined,
            error: msg._genError,
          } as GenJobState)
        : undefined),
  );

  function openResult() {
    const res = job?.result;
    if (res?.app && res.app.type === "app") {
      openAppInPreview(res.app.id, res.app);
    } else if (res?.docPath) {
      const rel = res.docPath.replace(/\\/g, "/").split("/docs/").pop() ?? res.docPath;
      docViewer.set(`session:${rel}`);
      rightPanelVisible.set(true);
      rightTab.set("docs");
    }
  }

  async function cancel() {
    if (msg._genJobId) await cancelGenerate(msg._genJobId);
  }
</script>

<div class="gen-card">
  <div class="gen-head">
    <Sparkles size={13} class="gen-icon" />
    <span class="gen-title">{isUpdate ? "应用更新" : "应用工坊"}</span>
    {#if !job}
      <span class="gen-status">{msg.content || "等待服务器响应…"}</span>
    {:else if job.status === "queued"}
      <span class="gen-status">排队中…</span>
    {:else if job.status === "running"}
      <span class="gen-status">
        {job.step ?? (isUpdate ? "更新中" : "生成中")}… <span class="gen-pct">{job.pct ?? 0}%</span>
      </span>
    {:else if job.status === "done"}
      <span class="gen-status ok">✓ {isUpdate ? "更新完成" : "生成完成"}</span>
    {:else if job.status === "canceled"}
      <span class="gen-status">已取消</span>
    {:else}
      <span class="gen-status err">✗ {isUpdate ? "更新失败" : "生成失败"}</span>
    {/if}
  </div>

  {#if job?.status === "running"}
    <div class="gen-track">
      <div class="gen-bar" style:width={`${job.pct ?? 0}%`}></div>
    </div>
    {#if job.detail}
      <div class="gen-detail">
        <Loader2 size={11} class="spin" />
        {job.detail}
      </div>
    {/if}
  {/if}

  {#if job?.status === "done"}
    {#if job.result?.app}
      <div class="gen-done">
        {isUpdate
          ? `✓ 应用已更新：${job.result.app.name} v${job.result.app.version ?? ""}（已停靠右侧「应用预览」）`
          : `✓ 应用已就绪：${job.result.app.name}（已停靠右侧「应用预览」）`}
      </div>
      <button class="gen-btn" onclick={openResult}>打开应用</button>
    {:else if job.result?.docPath}
      <div class="gen-done">✓ 文档已生成</div>
      <button class="gen-btn" onclick={openResult}>查看文档</button>
    {/if}
  {:else if job?.status === "failed"}
    <div class="gen-fail">✗ {job.error ?? (isUpdate ? "更新失败" : "生成失败")}</div>
  {/if}

  {#if job?.status === "queued"}
    <button class="gen-btn stop" title="取消排队中的任务" onclick={cancel}>停止</button>
  {/if}
</div>

<style>
  .gen-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 640px;
  }
  .gen-head { display: flex; align-items: center; gap: 8px; }
  .gen-icon { color: var(--primary); flex-shrink: 0; }
  .gen-title { font-size: 12px; font-weight: 600; color: var(--text); }
  .gen-status { font-size: 12px; color: var(--dim); display: flex; align-items: center; gap: 6px; }
  .gen-status.ok { color: var(--success); }
  .gen-status.err { color: var(--error); }
  .gen-pct { font-variant-numeric: tabular-nums; }
  .gen-track { height: 5px; background: var(--hover-bg); border-radius: 3px; overflow: hidden; }
  .gen-bar { height: 100%; background: var(--primary); border-radius: 3px; transition: width .3s; }
  .gen-detail { font-size: 11px; color: var(--dim); display: flex; align-items: center; gap: 5px; }
  .gen-done { font-size: 12px; color: var(--success); }
  .gen-fail { font-size: 12px; color: var(--error); word-break: break-all; }
  .gen-btn {
    align-self: flex-start;
    padding: 4px 14px;
    border: 1px solid var(--primary);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--primary);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all .15s;
  }
  .gen-btn:hover { background: var(--primary); color: #fff; }
  .gen-btn.stop { border-color: var(--border); color: var(--dim); }
  .gen-btn.stop:hover { border-color: var(--error); color: var(--error); background: transparent; }
  .spin { animation: gen-spin 1s linear infinite; }
  @keyframes gen-spin { to { transform: rotate(360deg); } }
</style>
