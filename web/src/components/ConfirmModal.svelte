<script lang="ts">
  interface Props {
    title: string;
    message?: string;
    mode?: "confirm" | "input";
    inputLabel?: string;
    inputValue?: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
    onConfirm: (value?: string) => void;
    onCancel: () => void;
  }
  let { title, message, mode = "confirm", inputLabel, inputValue = "", confirmText = "确定", cancelText = "取消", danger = false, onConfirm, onCancel }: Props = $props();
  let input = $state(inputValue);
</script>

<div class="modal-overlay" onclick={() => onCancel()}>
  <div class="modal-box" onclick={(e) => e.stopPropagation()}>
    <div class="modal-head">
      <span>{title}</span>
      <button class="modal-close" onclick={() => onCancel()}>&#10005;</button>
    </div>
    {#if message}
      <div class="modal-msg">{message}</div>
    {/if}
    {#if mode === "input"}
      <div class="modal-input-row">
        {#if inputLabel}
          <label class="modal-label">{inputLabel}</label>
        {/if}
        <input
          type="text"
          bind:value={input}
          onkeydown={(e) => e.key === "Enter" && !danger && input.trim() && onConfirm(input.trim())}
          placeholder={inputLabel}
          autofocus
        />
      </div>
    {/if}
    <div class="modal-actions">
      <button class="modal-btn cancel" onclick={() => onCancel()}>{cancelText}</button>
      <button
        class="modal-btn"
        class:danger
        onclick={() => (mode === "input" ? input.trim() && onConfirm(input.trim()) : onConfirm())}
      >
        {confirmText}
      </button>
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(26, 29, 46, .35);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
  }
  .modal-box {
    width: 380px;
    max-width: 90vw;
    background: var(--surface);
    border-radius: var(--radius);
    box-shadow: 0 8px 40px rgba(26, 29, 46, .2);
    padding: 20px;
    display: flex;
    flex-direction: column;
  }
  .modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 12px;
  }
  .modal-close {
    background: transparent;
    border: none;
    color: var(--dim);
    font-size: 16px;
    cursor: pointer;
  }
  .modal-close:hover { color: var(--text); }
  .modal-msg { font-size: 13px; color: var(--text); line-height: 1.6; margin-bottom: 16px; }
  .modal-input-row { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
  .modal-label { font-size: 12px; color: var(--dim); }
  .modal-input-row input {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 12px;
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 13px;
    outline: none;
    transition: border-color .15s;
  }
  .modal-input-row input:focus { border-color: var(--primary); }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .modal-btn {
    padding: 7px 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all .15s;
  }
  .modal-btn:hover { background: var(--hover-bg); }
  .modal-btn.cancel { color: var(--dim); }
  .modal-btn.danger { background: var(--error); color: #fff; border-color: var(--error); }
  .modal-btn.danger:hover { background: var(--error); opacity: .9; }
</style>
