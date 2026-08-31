/**
 * 进化快照（Sprint 40）— apply 写入前快照受影响目标，rollback 一键还原
 * 快照为 JSON 文件（函数不可序列化）：tool-fix 只存完整 ToolDefinition，
 * restore 时由调用方从当前注册表取 handler 重注册
 * 路径全部注入（skills/、config/agents/、runtime-config.json），保证可测性
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { EvolutionAction, ToolDefinition } from "../types.js";

/** 校验子路径不越界：target 必须位于 base 内（防 meta-agent 产出 ../ 穿越） */
function safeJoin(base: string, ...parts: string[]): string | null {
  const target = resolve(base, ...parts);
  const rel = relative(base, target);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return target;
}

/** 校验用户可控标识符不携带路径穿越（expert/agentId/name；允许中文等字符，仅拒绝 / \ ..） */
function isSafeSegment(v: string): boolean {
  return !v.includes("..") && !v.includes("/") && !v.includes("\\");
}

export interface SnapshotDeps {
  dataDir: string;
  /** skills/ 根目录（默认 process.cwd()/skills，测试注入临时目录） */
  skillsDir: string;
  /** config/agents/ 根目录 */
  agentsDir: string;
  /** runtime-config.json 路径 */
  runtimeConfigPath: string;
  /** 当前工具定义（tool-fix 快照；未找到返回 undefined 跳过） */
  getToolDefinition: (name: string) => ToolDefinition | undefined;
}

interface SnapshotFile {
  file: string;
  content: string | null; // null = 原不存在（回滚删除）
  at: number;
}

interface SnapshotTool {
  toolName: string;
  definition: ToolDefinition;
  at: number;
}

export interface EvolutionSnapshot {
  proposalId: string;
  actionKind: EvolutionAction["kind"];
  files: SnapshotFile[];
  tools: SnapshotTool[];
  at: number;
}

export interface RestoreHooks {
  /** 工具描述回滚：用快照 definition 重注册（调用方从当前注册表取 handler） */
  registerTool: (name: string, definition: ToolDefinition) => void;
  /** 技能文件回滚后热加载（原存在场景） */
  reloadSkill?: (filePath: string) => void;
  /** 技能文件删除后卸载内存条目（原不存在场景） */
  unloadSkill?: (name: string) => boolean;
  /** 提示词回滚后热重载智能体 */
  reloadAgent?: (id: string) => boolean;
}

/** 从 SKILL.md 正文提取 frontmatter name（与 skill-evolution.register 同源规则） */
export function skillNameFromBody(body: string): string | null {
  const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const nameMatch = fm[1].match(/^name:\s*(.+)$/m);
  return nameMatch ? nameMatch[1].trim() : null;
}

export function snapshotDir(dataDir: string): string {
  return resolve(dataDir, "evolution", "snapshots");
}

export function snapshotPath(dataDir: string, proposalId: string): string {
  return resolve(snapshotDir(dataDir), `${proposalId}.json`);
}

/** apply 写入前快照（一次提案一次快照；失败由调用方决定是否阻断） */
export function captureSnapshot(deps: SnapshotDeps, proposalId: string, action: EvolutionAction): EvolutionSnapshot {
  const files: SnapshotFile[] = [];
  const tools: SnapshotTool[] = [];
  const now = Date.now();
  const readOrNull = (file: string): string | null => (existsSync(file) ? readFileSync(file, "utf-8") : null);

  switch (action.kind) {
    case "new-skill": {
      const name = skillNameFromBody(action.body);
      // expert/name 来自 meta-agent，防路径穿越
      if (name && isSafeSegment(action.expert) && isSafeSegment(name)) {
        const file = safeJoin(deps.skillsDir, action.expert, `${name}.md`);
        if (file) files.push({ file, content: readOrNull(file), at: now });
      }
      break;
    }
    case "config-change": {
      files.push({ file: deps.runtimeConfigPath, content: readOrNull(deps.runtimeConfigPath), at: now });
      break;
    }
    case "prompt-fix": {
      if (isSafeSegment(action.agentId)) {
        const file = safeJoin(deps.agentsDir, `${action.agentId}.yaml`);
        if (file) files.push({ file, content: readOrNull(file), at: now });
      }
      break;
    }
    case "tool-fix": {
      const definition = deps.getToolDefinition(action.toolName);
      if (definition) tools.push({ toolName: action.toolName, definition, at: now });
      break;
    }
    default:
      break; // new-tool/new-app：生成物在沙箱，无快照
  }

  return { proposalId, actionKind: action.kind, files, tools, at: now };
}

/** 校验恢复目标路径在合法目录集合内（防快照文件被篡改后恢复写到任意位置） */
function isSafeRestoreTarget(deps: SnapshotDeps, file: string): boolean {
  const roots = [deps.skillsDir, deps.agentsDir, dirname(deps.runtimeConfigPath)];
  return roots.some((root) => {
    const rel = relative(resolve(root), resolve(file));
    return !rel.startsWith("..") && !isAbsolute(rel);
  });
}

/** 回滚恢复（文件写回/删除 + 联动热重载；返回人类可读 detail） */
export function restoreSnapshot(
  deps: SnapshotDeps,
  snap: EvolutionSnapshot,
  hooks: RestoreHooks,
): { ok: boolean; detail: string } {
  const details: string[] = [];
  try {
    for (const f of snap.files) {
      if (!isSafeRestoreTarget(deps, f.file)) {
        return { ok: false, detail: `回滚目标越界，已拒绝: ${f.file}` };
      }
      if (f.content === null) {
        rmSync(f.file, { force: true });
        details.push(`已删除 ${f.file}`);
      } else {
        mkdirSync(dirname(f.file), { recursive: true });
        writeFileSync(f.file, f.content, "utf-8");
        details.push(`已恢复 ${f.file}`);
      }
    }
    for (const t of snap.tools) {
      hooks.registerTool(t.toolName, t.definition);
      details.push(`工具描述已恢复: ${t.toolName}`);
    }
    // 联动：技能/智能体热重载
    if (snap.actionKind === "new-skill" && snap.files.length > 0) {
      const name = skillNameFromBody(
        snap.files[0]!.content ?? "",
      ) ?? snap.files[0]!.file.split(/[\\/]/).pop()?.replace(/\.md$/, "") ?? null;
      if (name && snap.files[0]!.content !== null) {
        hooks.reloadSkill?.(snap.files[0]!.file);
      } else if (name) {
        hooks.unloadSkill?.(name);
      }
    }
    if (snap.actionKind === "prompt-fix") {
      const agentId = snap.files[0]?.file.split(/[\\/]/).pop()?.replace(/\.(yaml|yml)$/, "");
      if (agentId) hooks.reloadAgent?.(agentId);
    }
    return { ok: true, detail: details.join("；") || "无快照内容" };
  } catch (err) {
    return { ok: false, detail: `回滚失败: ${(err as Error).message}` };
  }
}

/** 读取提案快照（rollback 用；不存在返回 null） */
export function readSnapshot(dataDir: string, proposalId: string): EvolutionSnapshot | null {
  const file = snapshotPath(dataDir, proposalId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as EvolutionSnapshot;
  } catch {
    return null;
  }
}
