/**
 * SkillEvolution — 技能自动沉淀引擎 (M2.1)
 * 流水线: LLM 知识提取 → 去重 → 验证 → 评分 → 注册
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { skillRegistry } from "./skill-registry.js";
import type { Message } from "../types.js";
import type { ModelRouter } from "./model-router.js";

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

const M2_PROMPT = `你是一位知识沉淀专家。分析以下用户与AI助手的对话，提取可复用的专业知识技能。

# 指令
1. 识别对话中的核心问题领域
2. 提取可复用的解决方案模式、关键步骤、常见陷阱
3. 生成3-5个正则触发词（帮助后续类似问题自动激活此技能）
4. 确定最合适的智能体类型（从以下选择：default/coding/research/data-analysis/financial/game-dev/product-ops）
5. 确定需要的工具列表

# 输出格式（严格遵循）
---
name: <英文技能名，kebab-case>
version: "1.0"
triggers:
  - "<正则触发词1>"
  - "<正则触发词2>"
  - "<正则触发词3>"
expert: <agent-id>
tools_required:
  - <工具名>
  - <工具名>
---

# <中文技能标题>

## 问题域
<1-2句话描述此技能适用的场景和问题类型>

## 解决方案
<核心方法、关键步骤（3-5条）>

## 常见陷阱
<1-3条常见错误或注意事项>

## 示例
<如有代码示例则包含，否则省略>

# 注意
- 输出仅包含上述格式内容，不要添加任何额外说明
- 如果对话中没有可复用的知识，忽略

# 已有技能（避免重复）
{EXISTING_SKILLS}

# 对话（已截断关键部分）
{CONVERSATION}`;

export class SkillEvolution {
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

  scoreSkill(raw: string): number {
    const body = raw.replace(/^---[\s\S]*?---\n?/, "").trim();
    let score = 2;
    if (body.length > 400) score += 1;
    if (body.length > 1000) score += 1;
    if (body.includes("```")) score += 1;
    return Math.min(score, 5);
  }

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

  checkDuplicates(raw: string, agentId: string): boolean {
    const existing = skillRegistry.getSkillsForAgent(agentId);
    if (existing.length === 0) return false;

    const fm = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) return true;

    const nameMatch = fm[1].match(/^name:\s*(.+)$/m);
    if (!nameMatch) return true;
    const newName = nameMatch[1].trim().toLowerCase();

    const newBody = raw.replace(/^---[\s\S]*?---\n?/, "").trim().slice(0, 200);

    for (const s of existing) {
      if (s.name.toLowerCase() === newName) return true;
      const existingBody = s.body.slice(0, 200);
      const overlap = this.jaccardSimilarity(newBody, existingBody);
      if (overlap > 0.5) return true;
    }

    return false;
  }

  private jaccardSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);
    return intersection.size / union.size;
  }

  async evolveV2(
    agentId: string,
    messages: Message[],
    modelRouter: ModelRouter,
  ): Promise<SkillEvolutionResult | null> {
    const existingSkills = skillRegistry
      .getSkillsForAgent(agentId)
      .map((s) => `- ${s.name} (triggers: ${s.triggers.join(", ")})`)
      .join("\n");

    const conversationText = this.truncateConversation(messages);

    const prompt = M2_PROMPT.replace("{EXISTING_SKILLS}", existingSkills || "无").replace(
      "{CONVERSATION}",
      conversationText,
    );

    let rawGenerated: string;
    try {
      const resp = await modelRouter.completeWithProfile("default", [
        { role: "user", content: prompt },
      ]);
      rawGenerated = resp.text?.trim() ?? "";
    } catch {
      return null;
    }

    if (!rawGenerated || rawGenerated.length < 50) return null;

    if (!rawGenerated.startsWith("---")) {
      return null;
    }

    const nameMatch = rawGenerated.match(/^---\n[\s\S]*?^name:\s*(.+)$/m);
    const name = nameMatch ? nameMatch[1].trim() : `auto-${agentId}-${Date.now().toString(36)}`;

    const pendingDir = resolve(process.cwd(), "skills", "pending");
    mkdirSync(pendingDir, { recursive: true });
    const pendingPath = resolve(pendingDir, `${name}.md`);
    writeFileSync(pendingPath, rawGenerated, "utf-8");

    const validation = this.validate(pendingPath);
    if (!validation.valid) {
      return { name, score: 0, registered: false, path: pendingPath };
    }

    if (this.checkDuplicates(rawGenerated, agentId)) {
      return { name, score: 0, registered: false, path: pendingPath };
    }

    const score = this.scoreSkill(rawGenerated);

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

  private truncateConversation(messages: Message[]): string {
    const maxChars = 4000;
    const lines: string[] = [];
    let total = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      const line = `[${m.role}]: ${m.content.slice(0, 1000)}`;
      total += line.length;
      if (total > maxChars) break;
      lines.unshift(line);
    }

    return lines.join("\n");
  }

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

    const validation = this.validate(pendingPath);
    if (!validation.valid) {
      return { name, score: 0, registered: false, path: pendingPath };
    }

    const score = this.scoreSkill(body);

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
