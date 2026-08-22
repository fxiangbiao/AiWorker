/**
 * 首次运行引导 — 未配置 DEEPSEEK_API_KEY 时的交互配置流程
 * 三步：输入 API Key（写 .env）→ 选择权限模式（写 permissions.json）→ 确认目录
 * 完成/跳过均写 data/onboarding.json 标记，之后不再触发（/setup 可随时重进）
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

const MODES = ["ask", "plan", "auto"] as const;

export interface OnboardingDeps {
  /** 提问通道（TUI 输入行 / mock），返回 null 表示用户跳过 */
  ask: (question: string) => Promise<string | null>;
  dataDir: string;
  workingDir: string;
  /** 写入 .env 并立即生效（process.env） */
  writeEnv: (key: string, value: string) => void;
  /** 写入 config/permissions.json 的 default_mode */
  writeDefaultMode: (mode: string) => void;
  log: (line: string) => void;
}

export function onboardingMarkPath(dataDir: string): string {
  return resolve(dataDir, "onboarding.json");
}

/** 触发条件：未完成过引导（TUI 模式 + 无 key 由调用方判断） */
export function shouldOnboard(dataDir: string): boolean {
  return !existsSync(onboardingMarkPath(dataDir));
}

export async function runOnboarding(deps: OnboardingDeps): Promise<"completed" | "skipped"> {
  const { ask, dataDir, workingDir, writeEnv, writeDefaultMode, log } = deps;

  log("");
  log("首次运行引导：配置基本参数（之后可用 /setup 重新配置）");

  // 1. API Key
  const key = (await ask("请输入 DeepSeek API Key（留空跳过，稍后用 /setup 配置）"))?.trim() ?? "";
  if (key) {
    writeEnv("DEEPSEEK_API_KEY", key);
    log("✓ DEEPSEEK_API_KEY 已写入 .env（本次会话立即生效）");
  } else {
    log("· 已跳过 API Key（未配置前无法调用模型）");
  }

  // 2. 权限模式
  const mode = (await ask("选择权限模式 ask/plan/auto（回车默认 auto）"))?.trim().toLowerCase() ?? "";
  const validMode = (MODES as readonly string[]).includes(mode) ? mode : "auto";
  writeDefaultMode(validMode);
  log(`✓ 默认权限模式 → ${validMode}（写入 config/permissions.json）`);

  // 3. 目录确认
  log(`· 工作目录: ${workingDir}`);
  log(`· 数据目录: ${dataDir}`);

  // 完成标记（跳过也标记，避免每次启动都问）
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    onboardingMarkPath(dataDir),
    JSON.stringify({ completedAt: Date.now(), skipped: !key }, null, 2),
    "utf-8",
  );
  log(key ? "✓ 首次运行引导完成" : "· 已跳过引导（稍后可用 /setup 重新配置）");
  return key ? "completed" : "skipped";
}
