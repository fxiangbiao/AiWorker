import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { collectDescendants, killProcessTree } from "../src/tools/process-tree.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

describe("process-tree 杀树", () => {
  it("collectDescendants 自底向上取子树（含自身），root 不在表内时退化为自身", () => {
    const table = ["  1     0", "  100     1", "  200   100", "  300   200", "  400   100", "  500   999"].join("\n");
    expect(collectDescendants(table, 100)).toEqual([300, 200, 400, 100]);
    expect(collectDescendants(table, 777)).toEqual([777]);
    expect(collectDescendants("", 5)).toEqual([5]);
    expect(collectDescendants("pid ppid\n3 1\n", 1)).toEqual([3, 1]);
  });

  it("killProcessTree 杀掉目标进程：win32 走 taskkill /T /F，posix 走 ps 子树 SIGKILL", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    expect(child.pid).toBeGreaterThan(0);
    expect(isAlive(child.pid!)).toBe(true);

    killProcessTree(child.pid!);
    expect(await waitDead(child.pid!)).toBe(true);
  });

  it("killProcessTree 对已退出的 pid 不抛错（幂等）", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((r) => child.on("exit", r));
    expect(() => killProcessTree(child.pid!)).not.toThrow();
  });
});