/**
 * 确认通道 — 统一高危/计划操作的用户确认
 * CLI 走 stdin 交互；HTTP Server 走 SSE 挂起等待前端确认卡片响应
 * 子智能体上下文（runWithoutChannel 作用域）内一律 fail-closed，且**不触碰**全局 provider（不顶掉父会话通道）
 */

import { isChannelSuppressed } from "./channel-scope.js";

export interface ConfirmRequest {
  id: string;
  title: string;
  message: string;
  options: { value: string; label: string }[];
}

export type ConfirmProvider = (req: ConfirmRequest) => Promise<string | null>;

let provider: ConfirmProvider | null = null;

/** 注册确认提供者（HTTP server 每请求设置，CLI 用 stdin 实现），返回旧提供者 */
export function setConfirmProvider(fn: ConfirmProvider | null): ConfirmProvider | null {
  const prev = provider;
  provider = fn;
  return prev;
}

// ===== HTTP SSE 确认队列 =====
// server 通过 confirmProvider 把请求挂起，前端 POST /api/v1/confirm 响应后 resolve

interface PendingConfirm {
  resolve: (value: string | null) => void;
  timer: NodeJS.Timeout;
  /** 该次请求实际提供的选项值：客户端回传未提供的值一律拒绝（防伪造 allow_project 之类） */
  values: Set<string>;
}

const pending = new Map<string, PendingConfirm>();

/** 发起一个挂起等待的确认请求（HTTP 场景），返回 Promise，等待 confirmResponse 或超时 */
export function createHttpConfirmProvider(send: (req: ConfirmRequest) => void, timeoutMs = 30000) {
  return (req: ConfirmRequest): Promise<string | null> => {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(req.id);
        resolve(null);
      }, timeoutMs);
      pending.set(req.id, { resolve, timer, values: new Set(req.options.map((o) => o.value)) });
      send(req);
    });
  };
}

/** 前端提交确认结果；值必须是该次请求提供过的选项，否则按无效处理（不改动挂起状态） */
export function confirmResponse(id: string, value: string | null): boolean {
  const item = pending.get(id);
  if (!item) return false;
  if (value !== null && !item.values.has(value)) return false;
  clearTimeout(item.timer);
  pending.delete(id);
  item.resolve(value);
  return true;
}

/** 发起确认，返回用户选择的 option.value；取消/超时返回 null */
export async function requestConfirm(
  message: string,
  options: { value: string; label: string }[] = [
    { value: "allow", label: "允许" },
    { value: "deny", label: "拒绝" },
  ],
  title = "操作确认",
): Promise<string | null> {
  if (isChannelSuppressed()) return null;
  if (provider) {
    return provider({ id: `cf-${Date.now().toString(36)}`, title, message, options });
  }
  // CLI 默认走 stdin
  return stdinConfirm(message, options);
}

async function stdinConfirm(message: string, options: { value: string; label: string }[]): Promise<string | null> {
  const { stdin, stdout } = await import("node:process");
  const rawMode = typeof stdin.setRawMode === "function";
  if (rawMode) stdin.setRawMode(false);
  stdin.resume();

  return new Promise((resolve) => {
    const labels = options.map((o, i) => `${i + 1}.${o.label}`).join("  ");
    stdout.write(`\n⚠️  ${message} [${labels}] `);

    const handler = (data: Buffer) => {
      const input = data.toString("utf-8").trim().toLowerCase();
      stdin.removeListener("data", handler);
      if (rawMode) stdin.setRawMode(true);
      stdout.write("\n");

      const idx = parseInt(input, 10) - 1;
      const byLabel = options.find((o) => o.label.toLowerCase() === input);
      const byValue = options.find((o) => o.value === input);
      const chosen = options[idx] ?? byLabel ?? byValue;
      resolve(chosen ? chosen.value : null);
    };

    stdin.once("data", handler);

    // 超时安全阀（30 秒后自动拒绝）
    setTimeout(() => {
      stdin.removeListener("data", handler);
      if (rawMode) stdin.setRawMode(true);
      stdout.write("\n");
      resolve(null);
    }, 30000);
  });
}
