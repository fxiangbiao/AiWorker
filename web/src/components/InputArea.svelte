<script lang="ts">
  import { stream, setSending } from "$lib/stores/stream.svelte";

  let text = $state("");
  let ta: HTMLTextAreaElement;
  let { onSend, inputMode, onSelectMode, onRetryLast, canRetry } = $props<{
    onSend: (msg: string) => void;
    inputMode: "chat" | "plan" | "debate";
    onSelectMode: (m: "chat" | "plan" | "debate") => void;
    onRetryLast?: () => void;
    canRetry?: boolean;
  }>();

  const placeholders = {
    chat: "输入消息，Enter 发送...",
    plan: "描述任务，多专家协作执行（如：开发一款放置类手游）...",
    debate: "输入辩论话题，双专家分析（如：React vs Vue 技术选型）...",
  } as const;

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
  <div class="mode-row">
    <button class="mode-pill" class:active={inputMode === "chat"} onclick={() => onSelectMode("chat")}>对话</button>
    <button class="mode-pill" class:active={inputMode === "plan"} onclick={() => onSelectMode("plan")}>智能体协作</button>
    <button class="mode-pill" class:active={inputMode === "debate"} onclick={() => onSelectMode("debate")}>双专家辩论</button>
  </div>
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
  </div>
</div>

<style>
  .input-area { padding: 12px 0 20px; flex-shrink: 0; }
  .input-inner { width: 96%; max-width: 1400px; margin: 0 auto; padding: 0 24px; }
  .mode-row { display: flex; gap: 6px; margin-bottom: 8px; }
  .mode-pill {
    padding: 4px 12px;
    border: 1px solid var(--border);
    border-radius: 20px;
    background: transparent;
    color: var(--dim);
    font-family: var(--font-ui);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all .15s;
  }
  .mode-pill.active { background: var(--primary); color: #fff; border-color: var(--primary); }
  .mode-pill:hover:not(.active) { background: var(--hover-bg); color: var(--primary-hover); }
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
</style>
