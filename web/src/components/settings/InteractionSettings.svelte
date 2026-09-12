<script lang="ts">
  /**
   * 设置 → 交互（Sprint 50 / IA 重构）
   * 思考展示与技能自动沉淀原本在「配置」tab 里与模型参数混排——它们不是模型参数，是**行为开关**，故独立成 tab。
   * 主题沿用既有 theme store（本地持久化，不走服务端）。
   */
  import { configState, configError, configNotice, applyConfigField } from "$lib/stores/settings.svelte";
  import { theme, applyTheme } from "$lib/stores/theme.svelte";
</script>

<div class="sec">
  <div class="sec-block">
    <div class="sec-title">对话行为</div>
    {#if !$configState}
      <div class="note">{$configError || "正在读取配置…"}</div>
    {:else}
      <label class="row">
        <input type="checkbox" checked={$configState.thinking} onchange={() => void applyConfigField("thinking", !$configState?.thinking)} />
        展示思考过程（thinking）
      </label>
      <div class="note">关闭后模型仍会思考（若模型支持），只是不在界面展示。</div>
      <label class="row">
        <input type="checkbox" checked={$configState.skillEvo} onchange={() => void applyConfigField("skillEvo", !$configState?.skillEvo)} />
        技能自动沉淀（回合结束后评估是否生成技能）
      </label>
      <div class="note">开启后每个回合结束都会做一次评估（会多一次模型调用）。</div>
    {/if}
  </div>

  <div class="sec-block">
    <div class="sec-title">外观</div>
    <div class="row">
      <button class="btn" class:active={$theme === "light"} onclick={() => applyTheme("light")}>浅色</button>
      <button class="btn" class:active={$theme === "dark"} onclick={() => applyTheme("dark")}>深色</button>
      <span class="note">主题保存在浏览器本地，不写服务端配置。</span>
    </div>
  </div>

  {#if $configNotice}<div class="ok">{$configNotice}</div>{/if}
  {#if $configError}<div class="err">{$configError}</div>{/if}
</div>

<style>
  .sec { display: flex; flex-direction: column; gap: 12px; }
  .sec-block { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px; }
  .sec-title { font-size: 12px; font-weight: 600; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
  .btn {
    padding: 4px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface); color: var(--text); font-size: 12px; cursor: pointer;
  }
  .btn:hover { background: var(--hover-bg); }
  .btn.active { border-color: var(--primary); color: var(--primary); background: var(--primary-light); }
  .note { font-size: 11px; color: var(--dim); line-height: 1.55; }
  .ok { font-size: 11px; color: var(--primary); }
  .err { font-size: 11px; color: var(--error); }
</style>
