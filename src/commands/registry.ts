/**
 * CLI 命令注册表 — 按序组装各命令组（数组顺序 = 匹配优先级 + /help 展示顺序）
 */

import type { CliCommand } from "./types.js";
import { sessionCommands } from "./session.js";
import { collabCommands } from "./collab.js";
import { skillsCommands } from "./skills.js";
import { configCommands } from "./config.js";
import { pluginsCommands } from "./plugins.js";
import { jobsCommands } from "./jobs.js";
import { packageCommands } from "./package.js";
import { miscCommands } from "./misc.js";

export type { CliCommand, CommandContext, CommandAction } from "./types.js";

/** 完整命令列表（顺序即优先级：plan/debate 在前，help/exit 在后） */
export function buildCliCommands(): CliCommand[] {
  return [
    ...collabCommands, // plan, debate
    ...configCommands, // mode, status, thinking, config
    ...sessionCommands, // new, log, sessions, switch, copy, trace, context
    ...skillsCommands, // skill, skills, skill-evo
    ...pluginsCommands, // plugins, install
    ...jobsCommands, // bg, jobs, schedule
    ...packageCommands, // pkg export/list
    ...miscCommands, // mcps, help, exit
  ];
}
