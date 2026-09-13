<script lang="ts">
  /**
   * 设置面板（Sprint 50 / IA 重构）— 「会写配置、改变行为」的都归这里
   *
   * 与控制台的分工：设置 = 我改它；控制台 = 我看它。
   * 五个 tab：模型 / 安全 / 工作区 / 交互 / 关于。
   * 布局规则（上一轮踩过的坑，这里从一开始就守住）：
   *   外层**唯一**滚动容器 + 左导航不滚动 + 列内非滚动行 `flex: 0 0 auto`；子组件不许自带 `overflow-y`。
   */
  import { onMount } from "svelte";
  import { settingsTab, type SettingsTab } from "$lib/stores/shell.svelte";
  import { loadConfigState, loadSandbox, loadDeviceStatus } from "$lib/stores/settings.svelte";
  import ModelSettings from "./settings/ModelSettings.svelte";
  import SecuritySettings from "./settings/SecuritySettings.svelte";
  import WorkspaceSettings from "./settings/WorkspaceSettings.svelte";
  import InteractionSettings from "./settings/InteractionSettings.svelte";
  import AboutSettings from "./settings/AboutSettings.svelte";

  const TABS: Array<{ id: SettingsTab; label: string; hint: string }> = [
    { id: "model", label: "模型", hint: "模型选择、生成参数与能力实测" },
    { id: "security", label: "安全", hint: "权限规则、受保护路径、沙箱强制项" },
    { id: "workspace", label: "工作区", hint: "工作目录与沙箱读写根" },
    { id: "interaction", label: "交互", hint: "思考展示、技能沉淀、主题" },
    { id: "about", label: "关于", hint: "版本、数据目录、存储与运行时" },
  ];

  onMount(() => {
    void loadConfigState();
    void loadSandbox();
    void loadDeviceStatus();
  });
</script>

<div class="settings">
  <div class="set-nav">
    {#each TABS as t (t.id)}
      <button class="set-nav-btn" class:active={$settingsTab === t.id} title={t.hint} onclick={() => settingsTab.set(t.id)}>
        {t.label}
      </button>
    {/each}
    <div class="set-nav-hint">{TABS.find((t) => t.id === $settingsTab)?.hint ?? ""}</div>
  </div>
  <div class="set-body">
    {#if $settingsTab === "model"}
      <ModelSettings />
    {:else if $settingsTab === "security"}
      <SecuritySettings />
    {:else if $settingsTab === "workspace"}
      <WorkspaceSettings />
    {:else if $settingsTab === "interaction"}
      <InteractionSettings />
    {:else}
      <AboutSettings />
    {/if}
  </div>
</div>

<style>
  .settings { display: flex; flex: 1 1 auto; min-height: 0; min-width: 0; }
  .set-nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 0 0 92px;
    padding: 8px 6px;
    border-right: 1px solid var(--border);
    min-height: 0;
  }
  .set-nav-btn {
    text-align: left;
    font-size: 12px;
    padding: 6px 10px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    cursor: pointer;
  }
  .set-nav-btn:hover { background: var(--hover-bg); }
  .set-nav-btn.active { background: var(--primary-light); color: var(--primary); font-weight: 600; }
  .set-nav-hint { margin-top: auto; font-size: 10px; color: var(--dim); line-height: 1.5; padding: 6px 8px; }
  /* 唯一滚动容器 */
  .set-body { flex: 1 1 auto; min-width: 0; min-height: 0; overflow-y: auto; padding: 12px 14px; }
</style>
