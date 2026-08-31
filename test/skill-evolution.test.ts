import { describe, it, expect, afterEach } from "vitest";
import { SkillEvolution } from "../src/core/skill-evolution.js";
import { skillRegistry } from "../src/core/skill-registry.js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

const skillEvo = new SkillEvolution();

afterEach(() => {
  skillRegistry.clear();
});

describe("SkillEvolution", () => {
  describe("validate", () => {
    it("应该检测缺少 YAML frontmatter 的技能文件", () => {
      const result = skillEvo.validate(__filename);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("缺少 YAML frontmatter");
    });
  });

  describe("jaccardSimilarity", () => {
    it("完全相同的字符串相似度应为 1", () => {
      const result = (skillEvo as any).jaccardSimilarity("hello world test", "hello world test");
      expect(result).toBe(1);
    });

    it("完全不同字符串相似度应为 0", () => {
      const result = (skillEvo as any).jaccardSimilarity("hello world", "foo bar baz");
      expect(result).toBe(0);
    });

    it("部分重叠应有合理相似度", () => {
      const result = (skillEvo as any).jaccardSimilarity("hello world foo", "hello world bar");
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThan(1);
    });
  });

  describe("checkDuplicates", () => {
    it("空技能库应返回 false", () => {
      skillRegistry.clear();
      const raw = "---\nname: unique-skill\ntriggers:\n  - \"test\"\nexpert: default\n---\n\n# Body";
      const result = skillEvo.checkDuplicates(raw, "default");
      expect(result).toBe(false);
    });
  });

  describe("scoreSkill", () => {
    it("极短的 body 应得低分", () => {
      const raw = "---\nname: test\ntriggers:\n  - test\nexpert: default\n---\n\nshort";
      const score = skillEvo.scoreSkill(raw);
      expect(score).toBeLessThanOrEqual(3);
    });

    it("含代码示例应额外加分", () => {
      const body = "x".repeat(500) + "\n```typescript\nconst x = 1;\n```";
      const raw = "---\nname: test\ntriggers:\n  - test\nexpert: default\n---\n\n" + body;
      const score = skillEvo.scoreSkill(raw);
      expect(score).toBeGreaterThanOrEqual(3);
    });
  });

  describe("register", () => {
    it("合法技能注册成功：文件落盘 + 注册表可查 + pending 清理", () => {
      skillRegistry.clear();
      const pending = resolve(process.cwd(), "data-test-skill-evo", "pending.md");
      mkdirSync(dirname(pending), { recursive: true });
      const target = resolve(process.cwd(), "skills", "default", "reg-skill.md");
      try {
        writeFileSync(pending, "---\nname: reg-skill\ntriggers:\n  - \"触发\"\nexpert: default\n---\n\n# 正文\n\n足够长的正文内容。\n", "utf-8");
        const ok = skillEvo.register(pending, "default");
        expect(ok).toBe(true);
        expect(skillRegistry.getSkillsForAgent("default").some((s) => s.name === "reg-skill")).toBe(true);
        expect(existsSync(pending)).toBe(false);
        expect(existsSync(target)).toBe(true);
      } finally {
        try { skillRegistry.unloadSkill("reg-skill"); } catch { /* ignore */ }
        try { const fs = require("node:fs"); fs.rmSync(target, { force: true }); } catch { /* ignore */ }
      }
    });

    it("解析失败（非法 YAML）返回 false 且回滚已写文件", () => {
      skillRegistry.clear();
      const pending = resolve(process.cwd(), "data-test-skill-evo", "bad.md");
      mkdirSync(dirname(pending), { recursive: true });
      // name 可提取但 YAML 解析失败（未闭合数组）→ reloadSkill 返回 null → register 应返回 false 并清理
      writeFileSync(pending, "---\nname: bad-skill\nbadkey: [unclosed\nexpert: default\n---\n\n# 正文\n", "utf-8");
      const target = resolve(process.cwd(), "skills", "default", "bad-skill.md");
      try {
        const ok = skillEvo.register(pending, "default");
        expect(ok).toBe(false);
        expect(existsSync(target)).toBe(false); // 已回滚，不残留
      } finally {
        try { const fs = require("node:fs"); fs.rmSync(target, { force: true }); } catch { /* ignore */ }
      }
    });
  });
});
