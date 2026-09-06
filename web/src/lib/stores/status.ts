import { writable } from "svelte/store";

export const serverOnline = writable(false);
export const currentModel = writable("--");
/** 进程级全局 token 累计（Sprint 44：StatusBar 标注「全局」；费用统计已移除） */
export const totalTokens = writable(0);
export const promptTokens = writable(0);
export const completionTokens = writable(0);
/** 当前模型上下文窗口（token；Sprint 44，来自 /status） */
export const contextWindow = writable(0);
export const workingDir = writable("");
export const skills = writable<string[]>([]);
