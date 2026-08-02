/**
 * readline 命令历史持久化 — 加载/追加/去重
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const MAX_LINES = 500;

export function historyFilePath(dataDir?: string): string {
  try {
    return join(homedir(), ".aiworker_history");
  } catch {
    return dataDir ? join(dataDir, ".aiworker_history") : ".aiworker_history";
  }
}

export function loadHistory(filePath: string): string[] {
  try {
    const raw = readFileSync(filePath, "utf-8");
    return raw.split("\n").map((l) => l.trim()).filter(Boolean).slice(-MAX_LINES);
  } catch {
    return [];
  }
}

/** 追加单条命令：去重相邻重复，写入文件 */
export function appendHistory(filePath: string, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const existing = loadHistory(filePath);
    if (existing[existing.length - 1] === trimmed) return;
    existing.push(trimmed);
    const kept = existing.slice(-MAX_LINES);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, kept.join("\n") + "\n", "utf-8");
  } catch {
    // 历史写入失败不影响主流程
  }
}
