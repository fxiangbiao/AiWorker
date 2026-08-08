/**
 * 技能注册表 — 单例模式
 * 设计依据：调研报告 3.3 节 — SKILL.md 运行时动态组装
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkillDef, ToolContext } from "../types.js";
import { toolRegistry } from "./tool-registry.js";

class SkillRegistry {
  private skills: SkillDef[] = [];
  private static instance: SkillRegistry;

  static getInstance(): SkillRegistry {
    if (!SkillRegistry.instance) {
      SkillRegistry.instance = new SkillRegistry();
    }
    return SkillRegistry.instance;
  }

  /** 从目录递归加载所有 SKILL.md 文件 */
  loadFromDir(dir: string): number {
    if (!existsSync(dir)) return 0;

    let loaded = 0;
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        loaded += this.loadFromDir(fullPath);
      } else if (entry.name === "SKILL.md") {
        try {
          const skill = this.parseSkillFile(fullPath);
          this.skills.push(skill);
          loaded++;
        } catch {
          // 解析失败静默跳过
        }
      }
    }

    return loaded;
  }

  private parseSkillFile(filePath: string): SkillDef {
    const raw = readFileSync(filePath, "utf-8");

    const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!frontmatterMatch) {
      throw new Error(`SKILL.md 缺少 YAML frontmatter: ${filePath}`);
    }

    const yamlStr = frontmatterMatch[1];
    const body = frontmatterMatch[2].trim();
    const meta = parseYaml(yamlStr) as Record<string, unknown>;

    const fallbackDesc = body.match(/^#\s+([^\n]+)/)?.[1]?.trim() ?? "";
    return {
      name: (meta.name as string) ?? basename(resolve(filePath, "..")),
      version: (meta.version as string) ?? "1.0",
      description: (meta.description as string)?.trim() || fallbackDesc,
      triggers: (meta.triggers as string[]) ?? [],
      expert: (meta.expert as string) ?? "general",
      toolsRequired: (meta.tools_required as string[]) ?? [],
      modelPreference: meta.model_preference as string | undefined,
      body,
      raw,
      filePath,
    };
  }

  /** 获取指定智能体的所有技能 */
  getSkillsForAgent(agentId: string): SkillDef[] {
    return this.skills.filter((s) => s.expert === agentId || s.expert === "common");
  }

  /** 根据用户输入匹配技能（正则快速匹配） */
  match(input: string, agentId: string): SkillDef[] {
    const candidates = this.getSkillsForAgent(agentId);
    return candidates.filter((s) => {
      if (s.triggers.length === 0) return true;
      return s.triggers.some((t) => {
        try {
          return new RegExp(t, "i").test(input);
        } catch {
          // SKILL.md 中的无效正则 → 跳过此触发词
          return false;
        }
      });
    });
  }

  /** 获取可用的技能（过滤掉依赖不满足的） */
  getAvailableSkills(agentId: string, ctx?: ToolContext): SkillDef[] {
    return this.getSkillsForAgent(agentId).filter((s) => {
      if (s.toolsRequired.length === 0) return true;
      if (!ctx) return true;
      return s.toolsRequired.every((toolName) => toolRegistry.isAvailable(toolName));
    });
  }

  /** 生成技能列表注入文本（用于 system prompt） */
  getInjectedPrompt(agentId: string, userInput?: string): string {
    const skills = userInput ? this.match(userInput, agentId) : this.getSkillsForAgent(agentId);

    if (skills.length === 0) return "";

    const header = `\n\n-- 可用技能 --\n以下是你可以使用的专业技能，按需调用：\n`;
    const list = skills
      .map((s) => `### ${s.name}\n触发词: ${s.triggers.join(", ")}\n${s.body.slice(0, 800)}`)
      .join("\n\n");

    return header + list + `\n-- 技能列表结束 --\n`;
  }

  /** 获取已加载的技能数量 */
  get count(): number {
    return this.skills.length;
  }

  /** 获取所有技能列表 */
  getAll(): SkillDef[] {
    return [...this.skills];
  }

  /** 清空注册表（测试用） */
  clear(): void {
    this.skills = [];
  }

  /** 热加载单个 SKILL.md 文件 */
  reloadSkill(filePath: string): SkillDef | null {
    try {
      const skill = this.parseSkillFile(filePath);
      // Remove existing entry with the same name
      const idx = this.skills.findIndex((s) => s.name === skill.name);
      if (idx >= 0) this.skills.splice(idx, 1);
      this.skills.push(skill);
      return skill;
    } catch {
      return null;
    }
  }
}

export const skillRegistry = SkillRegistry.getInstance();
