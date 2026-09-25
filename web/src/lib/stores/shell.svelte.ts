/**
 * 界面外壳状态（Sprint 50 / IA 重构）
 *
 * 存在的理由：设置与控制台是两个独立入口（Sidebar 底部 / TopBar ⚙ / StatusBar 徽章都要能打开它们，
 * 且要能直达某个 tab）。若用组件属性逐层传递，会出现"同一个面板被三处各自 holds 一个 open 变量"的
 * 分叉——这里收成一个 store，谁都能 `openSettings("security")`。
 */

import { writable } from "svelte/store";

/** 设置面板的 tab（改配置） */
export type SettingsTab = "model" | "security" | "workspace" | "interaction" | "about";
/** 控制台面板的 tab（看系统） */
export type ConsoleTab = "context" | "trace" | "audit" | "evolution" | "agents" | "skills" | "mcp" | "plugins" | "apps" | "processes" | "subagents" | "schedule" | "devices";

export const settingsOpen = writable(false);
export const consoleOpen = writable(false);
export const settingsTab = writable<SettingsTab>("model");
export const consoleTab = writable<ConsoleTab>("context");

export function openSettings(tab?: SettingsTab): void {
  if (tab) settingsTab.set(tab);
  settingsOpen.set(true);
}

export function openConsole(tab?: ConsoleTab): void {
  if (tab) consoleTab.set(tab);
  consoleOpen.set(true);
}
