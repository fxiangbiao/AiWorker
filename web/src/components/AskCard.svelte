<script lang="ts">
  import type { AskItem } from "$lib/stores/chat.svelte";
  let { ask, onRespond } = $props<{
    ask: AskItem;
    onRespond: (answer: string | null) => void;
  }>();
  let text = $state("");
  let submitting = $state(false);
  let inputEl: HTMLInputElement | undefined = $state();
  /** 多选：已勾选选项索引 */
  let selected: number[] = $state([]);

  // 自动聚焦输入框
  $effect(() => {
    inputEl?.focus();
  });

  function respond(value: string | null) {
    if (submitting) return;
    submitting = true;
    onRespond(value);
  }

  function submit() {
    const value = text.trim();
    if (!value) return;
    respond(value);
  }

  function toggle(i: number) {
    if (submitting) return;
    selected = selected.includes(i) ? selected.filter((x) => x !== i) : [...selected, i];
  }

  function submitSelection() {
    if (submitting || selected.length === 0) return;
    const answer = selected.map((i) => ask.options[i]).join(", ");
    respond(answer);
  }
</script>

<div class="ask-card">
  <div class="ac-title">
    ❓ 模型提问{ask.multiple ? "（可多选）" : ""}
    <span class="ac-hint">（30s 未作答将自动跳过）</span>
  </div>
  <div class="ac-question">{ask.question}</div>
  {#if ask.options && ask.options.length > 0}
    <div class="ac-options">
      {#each ask.options as opt, i}
        <button
          class="ac-btn"
          class:selected={selected.includes(i)}
          onclick={() => (ask.multiple ? toggle(i) : respond(opt))}
        >
          <span class="ac-num">{i + 1}</span>
          <span class="ac-opt-text">{opt}</span>
          {#if ask.multiple}
            <span class="ac-check">{selected.includes(i) ? "✓" : ""}</span>
          {/if}
        </button>
      {/each}
    </div>
    {#if ask.multiple}
      <div class="ac-selected">已选 {selected.length} 项</div>
      <button class="ac-confirm" onclick={submitSelection} disabled={submitting || selected.length === 0}>
        确认选择
      </button>
    {/if}
  {/if}
  <div class="ac-input-row">
    <input
      bind:this={inputEl}
      type="text"
      placeholder={ask.multiple ? "或直接输入其他回答，回车确认" : "输入回答，回车确认（或点上方选项）"}
      value={text}
      oninput={(e) => (text = e.currentTarget.value)}
      onkeydown={(e) => {
        if (e.key === "Enter") submit();
      }}
      disabled={submitting}
    />
    <button class="ac-submit" onclick={submit} disabled={submitting || !text.trim()}>提交</button>
    <button class="ac-skip" onclick={() => respond(null)} disabled={submitting}>跳过</button>
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
  .ac-hint { font-size: 11px; font-weight: 400; color: var(--dim); margin-left: 4px; }
  .ac-question { font-size: 12px; color: var(--text); margin: 6px 0 10px; line-height: 1.6; word-break: break-all; }
  .ac-options { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
  .ac-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    transition: all .15s;
  }
  .ac-btn:hover { background: var(--primary-light); border-color: var(--primary); color: var(--primary); }
  .ac-btn.selected { border-color: var(--primary); background: var(--primary-light); color: var(--primary); }
  .ac-num {
    flex: none;
    min-width: 18px;
    height: 18px;
    line-height: 18px;
    text-align: center;
    border-radius: 4px;
    background: var(--primary-light);
    color: var(--primary);
    font-size: 11px;
    font-weight: 600;
  }
  .ac-opt-text { word-break: break-all; }
  .ac-check { margin-left: auto; font-size: 13px; font-weight: 700; color: var(--primary); }
  .ac-selected { font-size: 11px; color: var(--dim); margin: 0 0 8px; }
  .ac-confirm {
    width: 100%;
    padding: 8px 0;
    margin-bottom: 10px;
    border: 1px solid var(--primary);
    border-radius: var(--radius-sm);
    background: var(--primary);
    color: #fff;
    font-family: var(--font-ui);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .ac-confirm:disabled { opacity: .5; cursor: not-allowed; }
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
  .ac-skip {
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--dim);
    font-family: var(--font-ui);
    font-size: 12px;
    cursor: pointer;
  }
  .ac-skip:hover { color: var(--error); border-color: var(--error); }
  .ac-skip:disabled { opacity: .5; cursor: not-allowed; }
</style>
