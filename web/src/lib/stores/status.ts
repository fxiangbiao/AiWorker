import { writable } from "svelte/store";

export const serverOnline = writable(false);
export const currentModel = writable("--");
export const totalTokens = writable(0);
export const promptTokens = writable(0);
export const completionTokens = writable(0);
export const workingDir = writable("");
export const skills = writable<string[]>([]);

/** 计费单价（每 1M token；deepseek: prompt 1 / completion 2） */
export const PRICING = { prompt: 1, completion: 2 };
