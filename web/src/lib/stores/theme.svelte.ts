/**
 * 主题 store（Sprint 34）
 * 顶栏开关切换 light/dark，localStorage 记忆（aiworker-theme），默认跟随系统
 */
import { writable, get } from "svelte/store";

const KEY = "aiworker-theme";

function initTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    /* 无痕模式忽略 */
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export const theme = writable<"light" | "dark">(initTheme());

export function applyTheme(t: "light" | "dark"): void {
  theme.set(t);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = t;
  }
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* 忽略 */
  }
}

export function toggleTheme(): void {
  applyTheme(get(theme) === "dark" ? "light" : "dark");
}
