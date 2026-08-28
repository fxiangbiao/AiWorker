<script lang="ts">
  /**
   * 即时生成向导（Sprint 35 补丁）
   * 异步生成：入队即返 jobId，进度经 genJobs store（WS gen/* 事件）驱动 + 取消
   */
  import { generateApp, cancelGenerate, genJobs } from "$lib/stores/apps.svelte";
  import { Sparkles, X, Loader2 } from "lucide-svelte";

  let { onClose }: { onClose: () => void } = $props();

  let description = $state("");
  let type = $state("webapp");
  let activeJob = $state<string | null>(null);
  let error = $state<string | null>(null);

  const job = $derived(activeJob ? $genJobs[activeJob] : null);

  // 生成完成自动关闭；失败/取消后重置 activeJob 允许同向导内重新提交
  $effect(() => {
    const st = job?.status;
    if (st === "done") {
      const t = setTimeout(() => onClose(), 1500);
      return () => clearTimeout(t);
    }
    if (st === "failed" || st === "canceled") {
      const t = setTimeout(() => (activeJob = null), 600);
      return () => clearTimeout(t);
    }
  });

  /** 应用分类简化：浮窗（交互式 Web 应用，可停靠预览/浮窗/透明小部件切换）与文档 */
  const TYPES = [
    { id: "webapp", label: "浮窗（应用）" },
    { id: "doc", label: "文档/报告" },
  ];

  async function submit() {
    if (!description.trim() || activeJob) return;
    error = null;
    const r = await generateApp(description.trim(), type);
    if (!r.ok) {
      error = r.error ?? "提交失败";
      return;
    }
    activeJob = r.jobId ?? null;
  }

  async function cancel() {
    if (!activeJob) return;
    await cancelGenerate(activeJob);
  }

  function pct(): number {
    return job?.pct ?? 0;
  }

  /** 生成中可随时关闭（后台继续，完成自动弹窗通知）；仅"停止生成"真正取消 */
  function closeWizard() {
    onClose();
  }
</script>

<div class="gw-overlay" onclick={closeWizard}>
  <div class="gw-box" onclick={(e) => e.stopPropagation()}>
    <div class="gw-head">
      <span class="gw-title"><Sparkles size={14} /> 即时生成应用</span>
      <button class="gw-close" title="关闭（生成继续在后台进行）" onclick={closeWizard}>
        <X size={15} />
      </button>
    </div>

    <label class="gw-label">描述要生成的内容</label>
    <textarea
      class="gw-input"
      bind:value={description}
      placeholder="例：番茄钟（25 分钟工作 + 5 分钟休息）；一份项目周报；文件批量重命名工具"
      rows={3}
      disabled={!!activeJob}
    ></textarea>

    <div class="gw-row">
      <div class="gw-field">
        <label class="gw-label">类型</label>
        <select class="gw-select" bind:value={type} disabled={!!activeJob}>
          {#each TYPES as t (t.id)}
            <option value={t.id}>{t.label}</option>
          {/each}
        </select>
      </div>
      <div class="gw-field">
        <label class="gw-label">展示</label>
        <span class="gw-hint">生成后默认停靠在右侧「应用预览」面板，可随时切换浮窗/透明小部件</span>
      </div>
    </div>

    {#if activeJob}
      <div class="gw-progress">
        <div class="gp-row">
          <span class="gp-label">
            {#if !job}等待服务器响应…
            {:else if job.status === "queued"}排队中…
            {:else if job.status === "running"}{job.step ?? "生成中"}…
            {:else if job.status === "done"}✓ 生成完成
            {:else if job.status === "canceled"}已取消
            {:else}✗ 生成失败{/if}
          </span>
          <span class="gp-pct">{pct()}%</span>
        </div>
        <div class="gp-track">
          <div class="gp-bar" style:width={`${pct()}%`} class:done={job?.status === "done"}></div>
        </div>
        <div class="gp-hint">
          {#if job?.status === "running"}
            <Loader2 size={11} class="gp-spin" /> {job?.detail ?? `正在生成：${job?.step ?? "…"}`}
          {:else if job?.status === "done"}
            <span class="gp-ok">✓ {job?.result?.app ? `应用已就绪：${job?.result?.app.name}` : "文档已生成（文档工作台打开）"}</span>
          {:else if job?.status === "failed"}
            <span class="gp-err">✗ {job?.error ?? "生成失败"}</span>
          {/if}
        </div>
        {#if job?.trace && job.trace.length > 0}
          <div class="gp-trace">
            {#each job.trace as t (t.at + t.text)}
              <div class="gp-trace-item">
                <span class="gp-trace-time">{new Date(t.at).toLocaleTimeString("zh-CN", { hour12: false })}</span>
                <span class="gp-trace-text">{t.text}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#if error}
      <div class="gw-error">{error}</div>
    {/if}

    <div class="gw-actions">
      <button class="gw-cancel" title="关闭（生成继续在后台进行）" onclick={onClose}>
        关闭
      </button>
      {#if activeJob && (job?.status === "running" || job?.status === "queued")}
        <button class="gw-stop" onclick={() => void cancel()} disabled={job?.status !== "queued"}>
          停止生成
        </button>
      {:else}
        <button class="gw-submit" onclick={() => void submit()} disabled={!!activeJob || !description.trim()}>
          <Sparkles size={12} /> 生成
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .gw-overlay {
    position: fixed; inset: 0; background: rgba(26, 29, 46, .35);
    display: flex; align-items: center; justify-content: center; z-index: 300;
  }
  .gw-box {
    width: 480px; max-width: 90vw;
    background: var(--surface); border-radius: var(--radius);
    box-shadow: 0 8px 40px rgba(0, 0, 0, .25);
    padding: 18px 20px; display: flex; flex-direction: column; gap: 10px;
  }
  .gw-head { display: flex; align-items: center; justify-content: space-between; }
  .gw-title { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 6px; color: var(--text); }
  .gw-close {
    border: none; background: transparent; color: var(--dim); cursor: pointer;
    display: flex; align-items: center; padding: 4px; border-radius: var(--radius-sm);
  }
  .gw-close:hover { background: var(--hover-bg); color: var(--text); }
  .gw-close:disabled { opacity: .4; }
  .gw-label { font-size: 11px; font-weight: 600; color: var(--dim); text-transform: uppercase; letter-spacing: .5px; }
  .gw-input {
    width: 100%; padding: 9px 12px;
    border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--bg); color: var(--text);
    font-family: var(--font-ui); font-size: 13px; resize: none;
  }
  .gw-input:focus { outline: none; border-color: var(--primary); }
  .gw-row { display: flex; gap: 12px; align-items: flex-end; }
  .gw-field { flex: 1; display: flex; flex-direction: column; gap: 4px; }
  .gw-hint { font-size: 11px; color: var(--dim); line-height: 1.5; padding-bottom: 6px; }
  .gw-select {
    padding: 7px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--bg); color: var(--text); font-family: var(--font-ui); font-size: 12px;
  }
  .gw-progress { display: flex; flex-direction: column; gap: 6px; padding: 4px 0; }
  .gp-row { display: flex; justify-content: space-between; align-items: center; }
  .gp-label { font-size: 12px; font-weight: 500; color: var(--text); }
  .gp-pct { font-size: 12px; color: var(--dim); font-variant-numeric: tabular-nums; }
  .gp-track { height: 6px; background: var(--hover-bg); border-radius: 3px; overflow: hidden; }
  .gp-bar { height: 100%; background: var(--primary); border-radius: 3px; transition: width .3s; }
  .gp-bar.done { background: var(--success); }
  .gp-hint { font-size: 11px; color: var(--dim); display: flex; align-items: center; gap: 5px; }
  .gp-trace {
    display: flex; flex-direction: column; gap: 2px;
    max-height: 96px; overflow-y: auto;
    border-top: 1px dashed var(--border); padding-top: 6px; margin-top: 2px;
  }
  .gp-trace-item { display: flex; gap: 8px; font-size: 11px; color: var(--dim); }
  .gp-trace-time { color: var(--primary); font-variant-numeric: tabular-nums; flex-shrink: 0; }
  .gp-trace-text { word-break: break-all; }
  .gp-ok { color: var(--success); }
  .gp-err { color: var(--error); }
  .gp-spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .gw-error { font-size: 12px; color: var(--error); padding: 6px 10px; background: rgba(232, 84, 107, .08); border-radius: var(--radius-sm); }
  .gw-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
  .gw-cancel {
    padding: 7px 16px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: transparent; color: var(--dim); font-size: 12px; cursor: pointer;
  }
  .gw-cancel:hover { background: var(--hover-bg); }
  .gw-stop {
    padding: 7px 16px; border: 1px solid var(--error); border-radius: var(--radius-sm);
    background: transparent; color: var(--error); font-size: 12px; cursor: pointer;
  }
  .gw-stop:hover { background: rgba(232, 84, 107, .08); }
  .gw-submit {
    display: flex; align-items: center; gap: 5px;
    padding: 7px 20px; border: none; border-radius: var(--radius-sm);
    background: var(--primary); color: #fff; font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .gw-submit:hover { background: var(--primary-hover); }
  .gw-submit:disabled { opacity: .5; cursor: default; }
</style>
