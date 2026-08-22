/**
 * 持久终端会话 — 跨调用保留 cwd/env（对齐 DSH dsh-terminal / dsh-tool-bash-persistent）
 * 实现：spawn cmd.exe /Q（或 /bin/sh），stdin 写命令 + echo <marker> 分隔符，读输出直到 marker
 * 超时即销毁进程（防缓冲区错位），下次 exec 自动重启
 */

import { spawn, type ChildProcess } from "node:child_process";
import { sanitizeEnv } from "../security/sandbox.js";

export interface TerminalExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

class TerminalSession {
  private child: ChildProcess | null = null;
  private buffer = "";
  private waiters: Array<{
    marker: string;
    resolve: (r: TerminalExecResult) => void;
  }> = [];

  start(): void {
    if (this.child && !this.child.killed) return;
    this.buffer = "";
    this.waiters = [];
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? "cmd.exe" : "/bin/sh", isWin ? ["/Q"] : [], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: sanitizeEnv(process.env),
    });
    this.child = child;
    // Windows 下强制 UTF-8 防中文乱码（与 terminal_exec 一致）
    if (isWin) {
      child.stdin!.write("chcp 65001 >nul\r\n");
    }
    child.stdout!.on("data", (d) => this.onData(String(d)));
    child.stderr!.on("data", (d) => this.onData(String(d)));
    child.on("exit", () => {
      // 先摘除本进程监听，避免旧子进程的迟到输出污染新会话
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      // 只有当前活跃进程退出才清引用（旧进程 exit 迟到时不误伤新 spawn 的进程）
      if (this.child === child) {
        this.child = null;
        const waiters = this.waiters;
        this.waiters = [];
        for (const w of waiters) {
          w.resolve({ ok: false, stdout: this.buffer, stderr: "终端会话进程已退出", timedOut: false });
        }
      }
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i]!;
      const idx = this.buffer.indexOf(w.marker);
      if (idx !== -1) {
        const before = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + w.marker.length);
        this.waiters.splice(i, 1);
        w.resolve({ ok: true, stdout: before.trim(), stderr: "", timedOut: false });
      }
    }
  }

  exec(command: string, timeoutMs: number): Promise<TerminalExecResult> {
    this.start();
    const child = this.child!;
    const marker = `__AWN_DONE_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}__`;
    const sep = `echo ${marker}`;
    // `&`（cmd）/`;`（sh）保证 marker 即使命令失败也会输出
    const line =
      process.platform === "win32" ? `${command} & ${sep}\r\n` : `${command}; ${sep}\n`;
    child.stdin!.write(line);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.marker === marker);
        if (i !== -1) {
          this.waiters.splice(i, 1);
          const partial = this.buffer;
          this.destroy();
          resolve({
            ok: false,
            stdout: partial,
            stderr: `命令执行超时(${Math.round(timeoutMs / 1000)}s)，会话已重置`,
            timedOut: true,
          });
        }
      }, timeoutMs);
      this.waiters.push({
        marker,
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      });
    });
  }

  destroy(): void {
    const c = this.child;
    this.child = null;
    this.buffer = "";
    const waiters = this.waiters;
    this.waiters = [];
    if (c) {
      c.stdout?.removeAllListeners("data");
      c.stderr?.removeAllListeners("data");
      try {
        c.kill();
      } catch {
        /* ignore */
      }
    }
    for (const w of waiters) {
      w.resolve({ ok: false, stdout: "", stderr: "会话已重置", timedOut: true });
    }
  }
}

class TerminalSessionPool {
  private sessions = new Map<string, TerminalSession>();

  get(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  start(sessionId: string): boolean {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = new TerminalSession();
      this.sessions.set(sessionId, s);
    }
    s.start();
    return true;
  }

  async exec(sessionId: string, command: string, timeoutMs: number): Promise<TerminalExecResult> {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = new TerminalSession();
      this.sessions.set(sessionId, s);
    }
    return s.exec(command, timeoutMs);
  }

  end(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.destroy();
      this.sessions.delete(sessionId);
    }
  }

  clear(): void {
    for (const s of this.sessions.values()) s.destroy();
    this.sessions.clear();
  }
}

export const terminalSessionPool = new TerminalSessionPool();

// 进程退出时清理子进程，避免 Windows 下残留孤儿 cmd
process.on("exit", () => terminalSessionPool.clear());
