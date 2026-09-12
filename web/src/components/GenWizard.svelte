<script lang="ts">
  /**
   * 即时生成向导（Sprint 35/36）
   * 提交后关闭弹窗：生成进度统一以聊天流状态卡片呈现（spawnGenCard → GenCard）
   */
  import { spawnGenCard } from "$lib/stores/apps.svelte";
  import { Sparkles, X } from "lucide-svelte";

  let { onClose }: { onClose: () => void } = $props();

  let description = $state("");
  let type = $state("webapp");
  let submitting = $state(false);
  let error = $state<string | null>(null);

  /** 应用分类简化：浮窗（交互式 Web 应用，可停靠预览/浮窗/透明小部件切换）与文档 */
  const TYPES = [
    { id: "webapp", label: "浮窗（应用）" },
    { id: "doc", label: "文档/报告" },
  ];

  async function submit() {
    if (!description.trim() || submitting) return;
    submitting = true;
    error = null;
    const r = await spawnGenCard(description.trim(), { type });
    submitting = false;
    if (!r.ok) {
      error = r.error ?? "提交失败";
      return;
    }
    onClose();
  }

  function closeWizard() {
    onClose();
  }
</script>

<div class="gw-overlay" onclick={closeWizard}>
  <div class="gw-box" onclick={(e) => e.stopPropagation()}>
    <div class="gw-head">
      <span class="gw-title"><Sparkles size={14} /> 即时生成应用</span>
      <button class="gw-close" title="关闭" onclick={closeWizard}>
        <X size={15} />
      </button>
    </div>

    <label class="gw-label">描述要生成的内容</label>
    <textarea
      class="gw-input"
      bind:value={description}
      placeholder="例：番茄钟（25 分钟工作 + 5 分钟休息）；一份项目周报；文件批量重命名工具"
      rows={3}
      disabled={submitting}
    ></textarea>

    <div class="gw-row">
      <div class="gw-field">
        <label class="gw-label">类型</label>
        <select class="gw-select" bind:value={type} disabled={submitting}>
          {#each TYPES as t (t.id)}
            <option value={t.id}>{t.label}</option>
          {/each}
        </select>
      </div>
      <div class="gw-field">
        <label class="gw-label">进度</label>
        <span class="gw-hint">生成进度会以状态卡片出现在聊天流中，完成后自动停靠右侧「应用」面板</span>
      </div>
    </div>

    {#if error}
      <div class="gw-error">{error}</div>
    {/if}

    <div class="gw-actions">
      <button class="gw-cancel" onclick={onClose}>
        关闭
      </button>
      <button class="gw-submit" onclick={() => void submit()} disabled={submitting || !description.trim()}>
        <Sparkles size={12} /> 生成
      </button>
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
  .gw-error { font-size: 12px; color: var(--error); padding: 6px 10px; background: rgba(232, 84, 107, .08); border-radius: var(--radius-sm); }
  .gw-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
  .gw-cancel {
    padding: 7px 16px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: transparent; color: var(--dim); font-size: 12px; cursor: pointer;
  }
  .gw-cancel:hover { background: var(--hover-bg); }
  .gw-submit {
    display: flex; align-items: center; gap: 5px;
    padding: 7px 20px; border: none; border-radius: var(--radius-sm);
    background: var(--primary); color: #fff; font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .gw-submit:hover { background: var(--primary-hover); }
  .gw-submit:disabled { opacity: .5; cursor: default; }
</style>
