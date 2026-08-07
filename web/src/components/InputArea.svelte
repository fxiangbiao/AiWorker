<script lang="ts">
  import { stream } from "$lib/stores/stream.svelte";

  let text = $state("");
  let ta: HTMLTextAreaElement;
  let { onSend } = $props<{ onSend: (msg: string) => void }>();

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
</script>

<div class="input-area">
  <div class="input-inner">
  <div class="input-row">
    <textarea
      bind:this={ta}
      bind:value={text}
      rows="1"
      placeholder={stream.sending ? "AiWorker 正在处理..." : "输入消息，Enter 发送..."}
      disabled={stream.sending}
      onkeydown={handleKeydown}
      oninput={handleInput}
    ></textarea>
    <button class="send-btn" disabled={stream.sending} onclick={submit}>&#8593;</button>
  </div>
  </div>
</div>

<style>
  .input-area { padding: 16px 0 20px; flex-shrink: 0; }
  .input-inner { width: 88%; max-width: 1200px; margin: 0 auto; padding: 0 24px; }
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
    background: var(--text);
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
</style>
