/**
 * 进化变更对比（Sprint 40 补：前后对比展示）
 * 数据零新增：before 从快照提取，after 从提案 action 提取，纯函数派生
 * 行级 diff 为简单 LCS（零依赖），供 Web/CLI 高亮渲染
 */

import { parse as parseYaml } from "yaml";
import type { EvolutionAction, EvolutionProposal } from "../types.js";
import type { EvolutionSnapshot } from "./evolution-snapshot.js";

export interface DiffLine {
  type: "same" | "add" | "del";
  text: string;
}

export interface ChangeView {
  proposalId: string;
  kind: EvolutionAction["kind"];
  title: string;
  before?: string;
  after: string;
  lines: DiffLine[];
}

/** 简单行级 diff（LCS 回溯；行数小，O(n*m) 可接受）；参数防御旧数据缺失 */
export function diffLines(before: string | undefined, after: string | undefined): DiffLine[] {
  const a = (before ?? "").split("\n");
  const b = (after ?? "").split("\n");
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: "del", text: a[i]! });
      i++;
    } else {
      out.push({ type: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++]! });
  while (j < m) out.push({ type: "add", text: b[j++]! });
  return out;
}

/** 从快照提取 before 内容（按类型；提取失败返回 undefined） */
export function extractBefore(snap: EvolutionSnapshot | null, action: EvolutionAction): string | undefined {
  if (!snap) return undefined;
  switch (action.kind) {
    case "tool-fix": {
      const tool = snap.tools.find((t) => t.toolName === action.toolName);
      return tool?.definition.function.description;
    }
    case "config-change": {
      const file = snap.files.find((f) => f.file.endsWith("runtime-config.json"));
      if (!file || file.content === null) return undefined;
      try {
        const cfg = JSON.parse(file.content) as Record<string, unknown>;
        const v = cfg[action.field];
        return v === undefined ? undefined : JSON.stringify(v, null, 2);
      } catch {
        return undefined;
      }
    }
    case "prompt-fix": {
      const file = snap.files.find((f) => f.file.endsWith(".yaml") || f.file.endsWith(".yml"));
      if (!file || file.content === null) return undefined;
      try {
        const yaml = parseYaml(file.content) as Record<string, unknown>;
        return typeof yaml.systemPrompt === "string" ? yaml.systemPrompt : undefined;
      } catch {
        return undefined;
      }
    }
    case "new-skill": {
      const file = snap.files[0];
      return file?.content ?? undefined;
    }
    default:
      return undefined; // new-tool/new-app：纯新增
  }
}

/** 提取 after 内容（按类型；旧格式数据缺新字段时回退 suggestion，保证可展示） */
export function extractAfter(action: EvolutionAction): string {
  switch (action.kind) {
    case "tool-fix":
      return action.newDescription ?? `（旧格式提案无新描述）\n${action.suggestion}`;
    case "prompt-fix":
      return action.newPrompt ?? `（旧格式提案无新提示词）\n${action.suggestion}`;
    case "config-change":
      return JSON.stringify({ [action.field]: action.value }, null, 2);
    case "new-skill":
      return action.body;
    case "new-tool":
      return `生成工具：${action.description}`;
    case "new-app":
      return `生成应用：${action.description}`;
  }
}

/** 构建变更对比视图（before=快照提取，after=提案 action） */
export function buildChangeView(proposal: EvolutionProposal, snap: EvolutionSnapshot | null): ChangeView {
  const before = extractBefore(snap, proposal.action);
  const after = extractAfter(proposal.action) ?? "";
  return {
    proposalId: proposal.id,
    kind: proposal.action.kind,
    title: proposal.title,
    before,
    after,
    lines: before !== undefined ? diffLines(before, after) : after.split("\n").map((text) => ({ type: "add", text })),
  };
}
