import { writable } from "svelte/store";

const API = "/api/v1";

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

/**
 * 拉取 /status 刷新状态栏各 store。配置改动（如切换模型）后应调用，
 * 让底部状态栏的模型/窗口立即反映，无需等待 30s 轮询或下一次 done 事件。
 */
export async function refreshStatus(): Promise<void> {
  try {
    const r = await fetch(`${API}/status`);
    if (!r.ok) throw new Error(String(r.status));
    const d = (await r.json()) as {
      model?: string;
      contextWindow?: number;
      workingDir?: string;
      skills?: string[];
      tokenUsage?: { total?: number; prompt?: number; completion?: number };
    };
    totalTokens.set(d.tokenUsage?.total || 0);
    promptTokens.set(d.tokenUsage?.prompt || 0);
    completionTokens.set(d.tokenUsage?.completion || 0);
    currentModel.set(d.model || "--");
    contextWindow.set(d.contextWindow || 0);
    workingDir.set(d.workingDir || "");
    skills.set(d.skills || []);
    serverOnline.set(true);
  } catch {
    serverOnline.set(false);
  }
}
