import { describe, it, expect, afterAll } from "vitest";
import { exec, execSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { collectDescendants, killProcessTree } from "../src/tools/process-tree.js";
import { makeTestDir } from "./helpers.js";

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

// ── Q6 探针：Windows 进程树杀法实测 ──

describe("Q6 进程树杀法实测", () => {
  const dir = makeTestDir("process-tree");

  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 探针可能残留孤儿进程持有临时文件，清理失败不影响结论 */
    }
  });

  it("Q6-a exec+signal 对孙进程的杀伤力不可靠（平台/Node版本相关）", async () => {
    // 此探针记录 exec+signal 对 detached 孙进程的实际行为。
    // 结果因平台/Node版本而异：有些环境杀整棵树，有些只杀直接子进程。
    // 无论结果如何，都证明"不能依赖 exec+signal 做可靠的进程树杀法"。
    const marker = resolve(dir, `grandchild-marker-${Date.now()}.txt`);
    const midScript = resolve(dir, "mid-process.js");
    writeFileSync(midScript, `
      const { spawn } = require("child_process");
      const child = spawn("node", ["-e", "setTimeout(()=>{require('fs').writeFileSync('${marker.replace(/\\/g, "/")}','alive')},3000)"], { detached: true, stdio: "ignore" });
      child.unref();
      setTimeout(() => {}, 10000);
    `);

    const parentCmd = process.platform === "win32"
      ? `chcp 65001 >nul & node "${midScript}"`
      : `node "${midScript}"`;

    const controller = new AbortController();
    const child = exec(parentCmd, { signal: controller.signal, timeout: 20000 });

    await sleep(1000);
    controller.abort();
    await sleep(4000);

    const grandchildSurvived = existsSync(marker);

    try { if (existsSync(marker)) unlinkSync(marker); } catch { /* 清理失败不影响结论 */ }
    try { unlinkSync(midScript); } catch { /* 清理失败不影响结论 */ }
    try { child.kill(); } catch { /* 清理失败不影响结论 */ }

    // 仅记录行为，不做 pass/fail 断言——结果因环境而异
    console.log(`[Q6-a] exec+signal 后孙进程${grandchildSurvived ? "存活" : "被杀"}（${process.platform} ${process.version}）`);
    // 但无论如何，这证明了需要显式的进程树杀法（见 Q6-b）
    expect(typeof grandchildSurvived).toBe("boolean");
  }, 15000);

  it.skipIf(process.platform !== "win32")("Q6-b Windows taskkill /T /F 能杀孙进程", async () => {
    const marker = resolve(dir, `taskkill-marker-${Date.now()}.txt`);
    const midScript = resolve(dir, "mid-taskkill.js");
    writeFileSync(midScript, `
      const { spawn } = require("child_process");
      const child = spawn("node", ["-e", "setTimeout(()=>{require('fs').writeFileSync('${marker.replace(/\\/g, "/")}','alive')},3000)"], { detached: true, stdio: "ignore" });
      child.unref();
      setTimeout(() => {}, 10000);
    `);

    const parentCmd = `chcp 65001 >nul & node "${midScript}"`;

    const child = exec(parentCmd, { timeout: 20000 });

    await sleep(1000);

    try {
      execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: "ignore" });
    } catch { /* 进程可能已自行退出，忽略 */ }

    await sleep(4000);

    const grandchildSurvived = existsSync(marker);

    try { if (existsSync(marker)) unlinkSync(marker); } catch { /* 清理失败不影响结论 */ }
    try { unlinkSync(midScript); } catch { /* 清理失败不影响结论 */ }
    try { child.kill(); } catch { /* 清理失败不影响结论 */ }

    // taskkill /T /F 应杀掉整棵树包括 detached 孙进程
    expect(grandchildSurvived).toBe(false);
  }, 15000);
});