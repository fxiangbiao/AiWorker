/**
 * SkillEvolution — 技能自动沉淀引擎
 * 流水线: 生成 SKILL.md → 验证 → 评分 → 注册
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { skillRegistry } from "./skill-registry.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface SkillEvolutionResult {
  name: string;
  score: number;
  registered: boolean;
  path: string;
}

export class SkillEvolution {
  /**
   * 验证 YAML frontmatter 和相关字段
   */
  validate(filePath: string): ValidationResult {
    const errors: string[] = [];
    try {
      const raw = readFileSync(filePath, "utf-8");
      const fm = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!fm) {
        errors.push("缺少 YAML frontmatter");
        return { valid: false, errors };
      }

      const content = fm[1];
      if (!content.includes("name:")) errors.push("缺少 name 字段");
      if (!content.includes("triggers:")) errors.push("缺少 triggers 字段");
      if (!content.includes("expert:")) errors.push("缺少 expert 字段");

      // Validate triggers are valid regex
      const trigMatch = content.match(/^triggers:\s*\n((?:\s*-\s+.+\n?)*)/m);
      if (trigMatch) {
        const triggers = trigMatch[1]
          .split("\n")
          .filter(Boolean)
          .map((t) => t.replace(/^\s*-\s*/, "").trim());
        for (const t of triggers) {
          try {
            new RegExp(t);
          } catch {
            errors.push(`无效正则触发词: ${t}`);
          }
        }
      }
    } catch (err) {
      errors.push(`读取文件失败: ${(err as Error).message}`);
    }
    return { valid: errors.length === 0, errors };
  }

  /**
   * LLM 评分 (1-5 星) — 返回占位分数，实际评分由调用方通过 LLM 完成
   * 此处返回保守默认值 3（凑合可用）
   */
  score(_filePath: string): number {
    // 在不引入额外 LLM 调用的前提下，基于文件质量打分
    // 后续 M2 可接入 LLM 评分（需传入 modelRouter）
    try {
      const raw = readFileSync(_filePath, "utf-8");
      const body = raw.replace(/^---[\s\S]*?---\n?/, "").trim();
      let score = 3; // default
      if (body.length > 800) score += 1; // 详细说明
      if (body.length > 1600) score += 0; // 过长不加分
      if (body.includes("```")) score += 1; // 含代码示例
      // Cap at 5
      return Math.min(score, 5);
    } catch {
      return 3;
    }
  }

  /**
   * 注册技能: pending/ → skills/{expert}/
   */
  register(filePath: string, expertId: string): boolean {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const fm = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!fm) return false;

      const nameMatch = fm[1].match(/^name:\s*(.+)$/m);
      if (!nameMatch) return false;
      const name = nameMatch[1].trim();

      const targetDir = resolve(process.cwd(), "skills", expertId);
      mkdirSync(targetDir, { recursive: true });
      const targetPath = resolve(targetDir, `${name}.md`);

      writeFileSync(targetPath, raw, "utf-8");
      skillRegistry.reloadSkill(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 完整流水线: 创建 SKILL.md → 验证 → 评分 → (>=3星)注册
   */
  evolve(agentId: string, sessionId: string, iterations: number, toolCalls: number): SkillEvolutionResult | null {
    const name = `auto-${agentId}-${Date.now().toString(36)}`;
    const body = [
      "---",
      `name: ${name}`,
      `version: "1.0"`,
      `triggers:`,
      `  - "${agentId}"`,
      `expert: ${agentId}`,
      "tools_required: []",
      "---",
      "",
      `## 自动沉淀技能`,
      "",
      `由 ${agentId} 智能体在复杂任务中自动生成。`,
      `迭代次数: ${iterations}`,
      `工具调用: ${toolCalls}`,
      `会话: ${sessionId}`,
      "",
      "### 指令",
      "",
      "根据上下文复现此任务的执行流程。",
      "",
    ].join("\n");

    const pendingDir = resolve(process.cwd(), "skills", "pending");
    mkdirSync(pendingDir, { recursive: true });
    const pendingPath = resolve(pendingDir, `${name}.md`);
    writeFileSync(pendingPath, body, "utf-8");

    // Validate
    const validation = this.validate(pendingPath);
    if (!validation.valid) {
      return { name, score: 0, registered: false, path: pendingPath };
    }

    // Score
    const score = this.score(pendingPath);

    // Register if >= 3 stars
    let registered = false;
    if (score >= 3) {
      registered = this.register(pendingPath, agentId);
    }

    return {
      name,
      score,
      registered,
      path: registered ? resolve(process.cwd(), "skills", agentId, `${name}.md`) : pendingPath,
    };
  }
}

export const skillEvolution = new SkillEvolution();
