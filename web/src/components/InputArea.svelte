<script lang="ts">
  import { stream, setSending } from "$lib/stores/stream.svelte";
  import { ImagePlus } from "lucide-svelte";
  import { store, saveSettings } from "$lib/stores/chat.svelte";

  let text = $state("");
  let ta: HTMLTextAreaElement;
  let { onSend, inputMode, onSelectMode, onRetryLast, canRetry, onPickImage, imageCount = 0, agents = [] as { id: string; name: string }[] } = $props<{
    onSend: (msg: string) => void;
    inputMode: "chat" | "plan" | "debate" | "forge";
    onSelectMode: (m: "chat" | "plan" | "debate" | "forge") => void;
    onRetryLast?: () => void;
    canRetry?: boolean;
    /** 多模态图片：点击选择/粘贴（Sprint 36） */
    onPickImage?: () => void;
    imageCount?: number;
    agents?: { id: string; name: string }[];
  }>();

  const placeholders = {
    chat: "输入消息，Enter 发送...",
    plan: "描述任务，多专家协作执行（如：开发一款放置类手游）...",
    debate: "输入辩论话题，双专家分析（如：React vs Vue 技术选型）...",
    forge: "描述想要的应用，AI 即时生成（如：一个带番茄钟的 webapp）...",
  } as const;

  /** 任务类型下拉（对话/智能体协作/应用工坊；双专家辩论走 CLI /debate） */
  const TASK_TYPES = [
    { id: "chat", label: "对话" },
    { id: "plan", label: "智能体协作" },
    { id: "forge", label: "应用工坊" },
  ] as const;

  /** 权限模式（安全级别） */
  const MODES = [
    { id: "ask", label: "Ask", hint: "只读问答（不执行写操作）" },
    { id: "plan", label: "Plan", hint: "每步确认后执行" },
    { id: "auto", label: "Auto", hint: "自动执行（高危操作仍确认）" },
  ] as const;

  function selectMode(m: string) {
    store.mode = m;
    saveSettings();
  }
  function selectAgent(id: string) {
    store.agentId = id;
    saveSettings();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function handleInput() {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
  }

  function submit() {
    const val = text.trim();
    if (!val || stream.sending) return;
    text = "";
    ta.style.height = "auto";
    onSend(val);
  }

  function stop() {
    stream.abortController?.abort();
    setSending(false, null);
  }
</script>

<div class="input-area">
  <div class="input-inner">
    <div class="input-row">
      <textarea
        bind:this={ta}
        bind:value={text}
        rows="1"
        placeholder={stream.sending ? "AiWorker 正在处理..." : placeholders[inputMode]}
        disabled={stream.sending}
        onkeydown={handleKeydown}
        oninput={handleInput}
      ></textarea>
      {#if stream.sending}
        <button class="send-btn stop" onclick={stop} title="停止请求">&#9632;</button>
      {:else}
        {#if canRetry && onRetryLast}
          <button class="retry-btn" onclick={() => onRetryLast()} title="重新生成当前回复">&#8635;</button>
        {/if}
        <button class="send-btn" onclick={submit}>&#8593;</button>
      {/if}
    </div>

    <!-- 会话控制条（输入框下方）：左=输入相关，右=执行配置 -->
    <div class="config-bar">
      <div class="cfg-group">
        {#if onPickImage && inputMode !== "forge"}
          <button class="cfg-btn img-pill" title="添加图片（也可直接粘贴到输入框）" onclick={onPickImage}>
            <ImagePlus size={12} />
            图片{#if imageCount > 0}<span class="img-count">{imageCount}</span>{/if}
          </button>
        {/if}
        <select
          class="cfg-select"
          value={inputMode}
          title="任务类型"
          onchange={(e) => onSelectMode((e.target as HTMLSelectElement).value as "chat" | "plan" | "forge")}
        >
          {#each TASK_TYPES as t (t.id)}
            <option value={t.id}>{t.label}</option>
          {/each}
        </select>
      </div>
      <div class="cfg-divider"></div>
      <div class="cfg-group">
        <select
          class="cfg-select"
          value={store.agentId}
          title="执行专家"
          onchange={(e) => selectAgent((e.target as HTMLSelectElement).value)}
        >
          {#each agents as a}
            <option value={a.id}>{a.name}</option>
          {/each}
        </select>
        {#each MODES as m (m.id)}
          <button
            class="cfg-btn mode-pill"
            class:active={store.mode === m.id}
            title={m.hint}
            onclick={() => selectMode(m.id)}
          >
            {m.label}
          </button>
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .input-area { padding: 8px 0 16px; flex-shrink: 0; }
  .input-inner { width: 96%; max-width: 1400px; margin: 0 auto; padding: 0 24px; }
  .input-row {
    display: flex;
    align-items: flex-end;
    gap: 10px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 14px;
    box-shadow: var(--shadow);
    transition: border-color .15s, box-shadow .15s;
  }
  .input-row:focus-within { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(75, 117, 238, .1); }
  textarea {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 14px;
    resize: none;
    outline: none;
    min-height: 24px;
    max-height: 120px;
    line-height: 1.6;
    padding: 0;
  }
  textarea::placeholder { color: var(--dim); }
  .send-btn {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: var(--primary);
    color: #fff;
    border: none;
    font-size: 15px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all .15s;
    flex-shrink: 0;
  }
  .send-btn:hover { background: var(--primary-hover); }
  .send-btn:disabled { opacity: .3; cursor: default; }
  .send-btn.stop { background: var(--error); }
  .send-btn.stop:hover { background: var(--error); }
  .retry-btn {
    width: 34px; height: 34px;
    border-radius: 50%;
    background: transparent;
    color: var(--primary);
    border: 1px solid var(--border);
    font-size: 15px;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all .15s;
    flex-shrink: 0;
  }
  .retry-btn:hover { background: var(--hover-bg); border-color: var(--primary); }

  /* ── 会话控制条 ── */
  .config-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 4px 0;
    flex-wrap: wrap;
  }
  .cfg-group { display: flex; align-items: center; gap: 6px; }
  .cfg-divider { width: 1px; height: 18px; background: var(--border); }
  .cfg-btn, .cfg-select {
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 20px;
    background: var(--surface);
    color: var(--dim);
    font-family: var(--font-ui);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all .15s;
  }
  .cfg-select { color: var(--text); outline: none; }
  .cfg-btn:hover:not(.active), .cfg-select:hover { border-color: var(--primary); color: var(--primary); }
  .cfg-select:focus { border-color: var(--primary); }
  .mode-pill.active { background: var(--primary); color: #fff; border-color: var(--primary); }
  .img-pill { display: flex; align-items: center; gap: 4px; }
  .img-count {
    font-size: 10px; font-weight: 600; color: var(--primary);
    background: var(--primary-light); border-radius: 8px; padding: 0 5px;
  }
</style>
