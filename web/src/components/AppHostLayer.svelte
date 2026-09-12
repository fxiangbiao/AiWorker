<script lang="ts">
  /**
   * 窗口层（Sprint 35）— 遍历运行中已打开的 app 应用渲染浮窗/小部件
   * panel（停靠）形态在右侧「应用」面板内嵌渲染，不在此层
   */
  import { apps, openWindows, winStates } from "$lib/stores/apps.svelte";
  import AppHost from "./AppHost.svelte";
</script>

{#each $apps as a (a.id)}
  {@const surf = $winStates[a.id]?.surface ?? "panel"}
  {#if a.type === "app" && a.status === "running" && $openWindows[a.id] && surf !== "panel"}
    <AppHost app={a} />
  {/if}
{/each}
