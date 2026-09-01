/**
 * 语音模型命令组（Sprint 43）— media status / download
 */

import chalk from "chalk";
import { modelManifest, modelReadyInfo, downloadModel } from "../media/model-manager.js";
import type { CliCommand } from "./types.js";

export const mediaCommands: CliCommand[] = [
  {
    name: "media",
    usage: "media status | media download <asr|tts>",
    description: "语音模型管理（就绪状态 / hf-mirror 下载）",
    detail: "status 查看 asr/tts 模型就绪与缺失文件；download <asr|tts> 从 hf-mirror 下载（幂等，跳过已就绪文件）",
    handler: async (ctx, arg) => {
      const parts = arg.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "";
      const kind = parts[1];
      const dataDir = ctx.dataDir;

      if (sub === "status") {
        ctx.writeLine(chalk.cyan("\n🎙 语音模型状态"));
        for (const k of ["asr", "tts"] as const) {
          const m = modelManifest(k);
          const info = modelReadyInfo(dataDir, k);
          const state = info.ready ? chalk.green("✅ 就绪") : chalk.yellow("⚠️ 未就绪");
          ctx.writeLine(`  ${state} ${k === "asr" ? "ASR" : "TTS"} ${chalk.dim(m.label)}（${(m.totalKb / 1024).toFixed(0)}MB）`);
          if (!info.ready) {
            for (const f of info.missing) ctx.writeLine(chalk.gray(`    缺: ${f}`));
          }
        }
        ctx.writeLine(chalk.gray("  /media download asr|tts 从 hf-mirror 下载"));
        ctx.printStatus();
        return "continue";
      }

      if (sub === "download") {
        if (kind !== "asr" && kind !== "tts") {
          ctx.writeLine(chalk.gray("用法: /media download <asr|tts>"));
          return "continue";
        }
        const m = modelManifest(kind);
        if (modelReadyInfo(dataDir, kind).ready) {
          ctx.writeLine(chalk.green(`✓ ${m.label} 已就绪，无需下载`));
          ctx.printStatus();
          return "continue";
        }
        ctx.writeLine(chalk.cyan(`\n⬇ 下载 ${m.label}（约 ${(m.totalKb / 1024).toFixed(0)}MB，hf-mirror 源）…`));
        const result = await downloadModel(dataDir, kind, (p) => {
          if (p.phase === "done") {
            ctx.writeLine(chalk.gray(`  ✓ ${p.file}（${(p.received / 1024 / 1024).toFixed(1)}MB）`));
          }
        });
        if (result.ok) {
          ctx.writeLine(chalk.green(`✓ 下载完成: 新增 ${result.downloaded.length} · 跳过 ${result.skipped.length}`));
          ctx.writeLine(kind === "asr" ? chalk.gray("  语音输入已就绪（Web 输入区 🎤 可用）") : chalk.gray("  离线 TTS 已就绪（优先于 edge-tts）"));
        } else {
          ctx.writeLine(chalk.red(`✗ 下载失败: ${result.error}`));
        }
        ctx.printStatus();
        return "continue";
      }

      ctx.writeLine(chalk.gray("用法: /media status | /media download <asr|tts>"));
      return "continue";
    },
  },
];
