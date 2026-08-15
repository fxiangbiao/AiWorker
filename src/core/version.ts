/**
 * 应用版本（单一来源：package.json）
 * Banner / --version / /status 命令 / Web API 均经此读取，避免硬编码漂移
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let cached: string | undefined;

export function getAppVersion(): string {
  if (cached === undefined) {
    try {
      cached = (
        JSON.parse(readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf-8")) as {
          version?: string;
        }
      ).version ?? "0.0.0";
    } catch {
      cached = "0.0.0";
    }
  }
  return cached;
}
