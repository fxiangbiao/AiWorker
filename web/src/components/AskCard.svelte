<script lang="ts">
  import type { AskItem } from "$lib/stores/chat.svelte";
  let { ask, onRespond } = $props<{
    ask: AskItem;
    onRespond: (answer: string | null) => void;
  }>();
  let text = $state("");
  let submitting = $state(false);

  function submit() {
    if (submitting) return;
    const value = text.trim();
    if (!value) return;
    submitting = true;
    onRespond(value);
  }
</script>

<div class="ask-card">
  <div class="ac-title">❓ 模型提问</div>
  <div class="ac-question">{ask.question}</div>
  {#if ask.options && ask.options.length > 0}
    <div class="ac-options">
      {#each ask.options as opt}
        <button class="ac-btn" onclick={() => { submitting = true; onRespond(opt); }}>{opt}</button>
      {/each}
    </div>
  {/if}
  <div class="ac-input-row">
    <input
      type="text"
      placeholder="输入回答，回车确认（或点上方选项）"
      value={text}
      oninput={(e) => (text = e.currentTarget.value)}
      onkeydown={(e) => {
        if (e.key === "Enter") submit();
      }}
    />
    <button class="ac-submit" onclick={submit} disabled={submitting || !text.trim()}>提交</button>
  </div>
</div>

<style>
  .ask-card {
    border: 1px solid var(--primary);
    border-radius: var(--radius-sm);
    padding: 12px 16px;
    background: rgba(86, 156, 214, .06);
    margin-bottom: 16px;
  }
  .ac-title { font-size: 12px; font-weight: 600; color: var(--primary); }
  .ac-question { font-size: 12px; color: var(--text); margin: 6px 0 10px; line-height: 1.6; word-break: break-all; }
  .ac-options { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
  .ac-btn {
    padding: 6px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 12px;
    cursor: pointer;
    transition: all .15s;
  }
  .ac-btn:hover { background: var(--primary-light); border-color: var(--primary); color: var(--primary); }
  .ac-input-row { display: flex; gap: 8px; }
  .ac-input-row input {
    flex: 1;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 12px;
  }
  .ac-input-row input:focus { outline: none; border-color: var(--primary); }
  .ac-submit {
    padding: 6px 16px;
    border: 1px solid var(--primary);
    border-radius: var(--radius-sm);
    background: var(--primary);
    color: #fff;
    font-family: var(--font-ui);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .ac-submit:disabled { opacity: .5; cursor: not-allowed; }
</style>
