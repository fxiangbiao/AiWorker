/**
 * 极简 .env 加载 — KEY=VALUE 注入 process.env（不覆盖已有变量）
 * 支持 # 注释、可选引号、BOM 容错；零依赖。
 * 调用时机：入口最顶部（任何配置读取之前），供 DEEPSEEK_API_KEY 等使用。
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnvFile(path?: string): void {
  const envPath = path ?? resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf-8").replace(/^\uFEFF/, "");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
