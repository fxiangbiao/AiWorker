/**
 * 临时 CI 诊断（看完结论即删）：在 ubuntu runner 上确定
 *   A) exec 的直接子进程是否就是命令本体（/bin/sh 会不会 fork 出孙进程）
 *   B) 旧杀树逻辑 kill(-pid)+kill(pid) 在该环境是否真能杀掉命令进程
 *   C) 旧逻辑复现 D2-c 场景（2500ms 写文件）后文件是否出现
 *   D) detached:true + 组杀 是否更可靠
 *   E) 新逻辑（ps 子树逐个 SIGKILL）是否可靠
 * 输出以 ::error:: 前缀 → 落到 GitHub annotations，可用公开 API 无 token 回读
 */

import { exec, execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (tag, data) => console.log(`::error::KILLDIAG ${tag} ${JSON.stringify(data)}`);

function psRow(pid) {
  try {
    return execFileSync("ps", ["-o", "pid=,ppid=,pgid=,sid=,stat=,comm=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "GONE";
  }
}

function childRows(pid) {
  try {
    const rows = execFileSync("ps", ["-eo", "pid=,ppid=,pgid=,comm="], { encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter((c) => c.length >= 4 && c[1] === String(pid));
    return rows.length ? rows.map((c) => c.join(" ")).join(" | ") : "-";
  } catch (e) {
    return `ps-failed:${e.message}`;
  }
}

const oldKill = (pid) => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
};

const sweepKill = (pid) => {
  let table = "";
  try {
    table = execFileSync("ps", ["-Ao", "pid=,ppid="], { encoding: "utf8" });
  } catch {
    /* ps 不可用 */
  }
  const children = new Map();
  for (const line of table.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2) continue;
    const p = Number(cols[0]);
    const pp = Number(cols[1]);
    if (!Number.isInteger(p) || !Number.isInteger(pp)) continue;
    if (!children.has(pp)) children.set(pp, []);
    children.get(pp).push(p);
  }
  const ordered = [];
  const walk = (x) => {
    for (const y of children.get(x) ?? []) walk(y);
    ordered.push(x);
  };
  walk(pid);
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* 不是进程组 */
  }
  for (const t of ordered) {
    try {
      process.kill(t, "SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
};

async function probeEnv() {
  let sh = "?";
  try {
    sh = execFileSync("bash", ["-c", "ls -l /bin/sh"], { encoding: "utf8" }).trim();
  } catch {
    /* ignore */
  }
  log("0-env", { platform: process.platform, node: process.version, sh, self: psRow(process.pid) });
}

async function probeDirectChild() {
  const child = exec(`node -e "console.log('CHILDPID='+process.pid)"`);
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  await new Promise((r) => child.on("close", r));
  const reported = (out.match(/CHILDPID=(\d+)/) || [])[1];
  log("A-direct-child", { childPid: child.pid, reportedPid: reported ?? null, samePid: reported === String(child.pid) });
}

async function probeOldKill() {
  const child = exec(`node -e "setInterval(()=>{},1000)"`);
  await sleep(250);
  const row = psRow(child.pid);
  const kids = childRows(child.pid);
  let groupErr = null;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (e) {
    groupErr = e.code ?? String(e.message);
  }
  await sleep(200);
  const afterGroup = psRow(child.pid);
  let singleErr = null;
  try {
    process.kill(child.pid, "SIGKILL");
  } catch (e) {
    singleErr = e.code ?? String(e.message);
  }
  await sleep(200);
  log("B-old-kill", { row, kids, groupErr, afterGroup, singleErr, afterSingle: psRow(child.pid) });
}

async function probeScenario(tag, killFn, options) {
  const file = join(tmpdir(), `aiw-probe-${tag}-${process.pid}.txt`);
  rmSync(file, { force: true });
  const child = exec(
    `node -e "setTimeout(()=>require('fs').writeFileSync(process.argv[1],'x'),2500)" "${file}"`,
    options,
  );
  await sleep(400);
  let killErr = null;
  try {
    killFn(child.pid);
  } catch (e) {
    killErr = e.code ?? String(e.message);
  }
  await sleep(2600);
  log(tag, { childPid: child.pid, fileExists: existsSync(file), killErr, row: psRow(child.pid) });
  rmSync(file, { force: true });
}

await probeEnv().catch((e) => log("0-env-err", { message: e.message }));
await probeDirectChild().catch((e) => log("A-err", { message: e.message }));
await probeOldKill().catch((e) => log("B-err", { message: e.message }));
await probeScenario("C-old-kill-scenario", oldKill).catch((e) => log("C-err", { message: e.message }));
await probeScenario("D-detached-group", oldKill, { detached: true }).catch((e) => log("D-err", { message: e.message }));
await probeScenario("E-sweep-kill", sweepKill).catch((e) => log("E-err", { message: e.message }));
log("Z-done", { ok: true });