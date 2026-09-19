/**
 * 进程树硬杀（terminal_exec 中断用）
 *
 * win32：exec 的 pid 是 cmd.exe，真实命令是其子进程 → taskkill /T /F 同步杀整棵树。
 *        （SIGTERM 会让 cmd.exe 体面退出但放过孙进程，绝不能作为第一步）
 * posix：不能假定子进程自成进程组 —— spawn/exec 未 detached 时子进程继承父进程的 pgid，
 *        kill(-pid) 只会 ESRCH；而命令可能由 shell fork 成孙进程。因此先按 `ps` 表快照
 *        整棵子树，再逐个 SIGKILL，最后兜底进程组。
 */

import { spawnSync } from "node:child_process";

/** 解析 `ps -Ao pid=,ppid=` 输出为 rootPid 子树（自底向上：后代先于祖先），root 恒含在内 */
export function collectDescendants(psText: string, rootPid: number): number[] {
  const children = new Map<number, number[]>();
  for (const line of psText.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2) continue;
    const pid = Number(cols[0]);
    const ppid = Number(cols[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  const ordered: number[] = [];
  const walk = (pid: number): void => {
    for (const child of children.get(pid) ?? []) walk(child);
    ordered.push(pid);
  };
  walk(rootPid);
  return ordered;
}

/** ps 不可用时返回空串 → 子树退化为自身，仍能单进程兜底 */
function processTable(): string {
  try {
    return spawnSync("ps", ["-Ao", "pid=,ppid="], { encoding: "utf8", timeout: 3000 }).stdout ?? "";
  } catch {
    return "";
  }
}

/** 硬杀 pid 及其全部后代；已退出的目标忽略，不阻塞调用方 */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
    } catch {
      /* 杀树失败不阻塞返回 */
    }
    return;
  }
  const targets = collectDescendants(processTable(), pid);
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* pgid 继承父进程时负号 pid 不是进程组：继续按子树逐个杀 */
  }
  for (const target of targets) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      /* 进程可能已退出 */
    }
  }
}