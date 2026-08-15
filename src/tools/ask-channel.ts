/**
 * 提问通道 — ask_user 工具的用户回答分发
 * 对齐 confirm-channel 的 provider 模式：CLI 走 stdin 自由文本；HTTP Server 走 SSE ask_user 事件挂起 + POST /api/v1/ask 响应
 */

export interface AskRequest {
  id: string;
  question: string;
  options: string[];
}

export type AskProvider = (req: AskRequest) => Promise<string | null>;

let provider: AskProvider | null = null;

/** 提问挂起状态（供 TUI 状态栏显示"等待你的回答"） */
let askWaiting = false;

/** 当前是否有提问正在等待用户回答 */
export function isAskWaiting(): boolean {
  return askWaiting;
}

/** 注册提问提供者（HTTP server 每请求设置，CLI 用 stdin 实现），返回旧提供者 */
export function setAskProvider(fn: AskProvider | null): AskProvider | null {
  const prev = provider;
  provider = fn;
  return prev;
}

// ===== HTTP SSE 提问队列 =====
// server 通过 askProvider 把请求挂起，前端 POST /api/v1/ask 回答后 resolve

interface PendingAsk {
  resolve: (value: string | null) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingAsk>();

/** 发起一个挂起等待的提问（HTTP 场景），返回 Promise，等待 askResponse 或超时 */
export function createHttpAskProvider(send: (req: AskRequest) => void, timeoutMs = 30000) {
  return (req: AskRequest): Promise<string | null> => {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(req.id);
        resolve(null);
      }, timeoutMs);
      pending.set(req.id, { resolve, timer });
      send(req);
    });
  };
}

/** 前端提交回答 */
export function askResponse(id: string, answer: string | null): boolean {
  const item = pending.get(id);
  if (!item) return false;
  clearTimeout(item.timer);
  pending.delete(id);
  item.resolve(answer);
  return true;
}

/** 发起提问，返回用户回答（自由文本或选中选项）；取消/超时返回 null */
export async function requestAsk(question: string, options: string[] = []): Promise<string | null> {
  askWaiting = true;
  try {
    if (provider) {
      return await provider({ id: `ask-${Date.now().toString(36)}`, question, options });
    }
    return await stdinAsk(question, options);
  } finally {
    askWaiting = false;
  }
}

async function stdinAsk(question: string, options: string[]): Promise<string | null> {
  const { stdin, stdout } = await import("node:process");
  const { default: chalk } = await import("chalk");
  const rawMode = typeof stdin.setRawMode === "function";
  if (rawMode) stdin.setRawMode(false);
  stdin.resume();

  return new Promise((resolve) => {
    // 多行排版：问题独立成行、选项逐行编号，避免长选项挤在一行换行错乱
    const lines: string[] = [];
    lines.push("");
    lines.push(`${chalk.cyan("❓")} ${question}`);
    if (options.length > 0) {
      for (let i = 0; i < options.length; i++) {
        lines.push(`   ${chalk.dim(`${i + 1})`)} ${options[i]}`);
      }
    }
    lines.push(
      chalk.dim(
        options.length > 0 ? "（直接输入回答，或输入选项序号后回车）: " : "（输入回答后回车）: ",
      ),
    );
    stdout.write(lines.join("\n"));

    const handler = (data: Buffer) => {
      const input = data.toString("utf-8").trim();
      stdin.removeListener("data", handler);
      if (rawMode) stdin.setRawMode(true);
      stdout.write("\n");
      if (!input) {
        resolve(null);
        return;
      }
      const idx = parseInt(input, 10);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= options.length) {
        resolve(options[idx - 1]!);
        return;
      }
      resolve(input);
    };

    stdin.once("data", handler);

    // 超时安全阀（30 秒后视为放弃）
    setTimeout(() => {
      stdin.removeListener("data", handler);
      if (rawMode) stdin.setRawMode(true);
      stdout.write("\n");
      resolve(null);
    }, 30000);
  });
}
