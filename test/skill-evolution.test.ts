import { describe, it, expect } from "vitest";
import { SkillEvolution } from "../src/core/skill-evolution.js";
import { skillRegistry } from "../src/core/skill-registry.js";

const skillEvo = new SkillEvolution();

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
});
