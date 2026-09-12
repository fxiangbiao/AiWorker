/**
 * 文档索引（Sprint 38 的 /docs 逻辑抽为可复用纯函数，产物工作台与 /docs 共用一份实现）
 * 只收 `.md`：会话资产（dataDir/docs 全量递归）与项目文档（工作目录递归，排除系统目录，
 * 深度 ≤4、数量 ≤200、单文件 ≤1MB）
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { DocEntry } from "../types.js";

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  "coverage",
  "out",
]);

const MAX_DEPTH = 4;
const MAX_DOCS = 200;
const MAX_DOC_BYTES = 1_000_000;

export function collectDocs(dataDir: string, projectDir: string): DocEntry[] {
  const docsDir = resolve(dataDir, "docs");
  const docs: DocEntry[] = [];

  const walkSession = (dir: string, base: string): void => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, e.name);
      if (e.isDirectory()) walkSession(full, join(base, e.name));
      else if (e.name.endsWith(".md")) {
        const st = statSync(full);
        docs.push({ root: "session", path: join(base, e.name).replace(/\\/g, "/"), title: e.name.replace(/\.md$/, ""), size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  walkSession(docsDir, "");

  const projectAbs = resolve(projectDir);
  const dataDirAbs = resolve(dataDir);
  const relData = relative(projectAbs, dataDirAbs);
  const excludeDataAbs =
    projectAbs !== dataDirAbs && relData !== "" && !relData.startsWith("..") && !isAbsolute(relData) ? dataDirAbs : null;
  const projectDocs: DocEntry[] = [];
  let scanStopped = false;

  const walkProject = (dir: string, base: string, depth: number): void => {
    if (scanStopped || depth > MAX_DEPTH || !existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (scanStopped) return;
      const full = resolve(dir, e.name);
      if (e.isDirectory()) {
        if (EXCLUDED_DIRS.has(e.name)) continue;
        if (excludeDataAbs && full === excludeDataAbs) continue;
        walkProject(full, join(base, e.name), depth + 1);
      } else if (e.name.endsWith(".md")) {
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.size > MAX_DOC_BYTES) continue;
        projectDocs.push({ root: "project", path: join(base, e.name).replace(/\\/g, "/"), title: e.name.replace(/\.md$/, ""), size: st.size, mtime: st.mtimeMs });
        if (projectDocs.length >= MAX_DOCS) {
          scanStopped = true;
          return;
        }
      }
    }
  };
  walkProject(projectDir, "", 0);
  projectDocs.sort((a, b) => b.mtime - a.mtime);
  docs.push(...projectDocs);

  return docs;
}
