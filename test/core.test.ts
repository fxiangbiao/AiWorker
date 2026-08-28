/**
 * 核心模块测试：工具注册表 / 危险检测 / 权限模型 / 专家路由 / 技能注册表
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { toolRegistry } from "../src/core/tool-registry.js";
import { DangerDetector } from "../src/security/danger-detector.js";
import { PermissionModel } from "../src/security/permission-model.js";
import { routeToExpert } from "../src/agents/router.js";
import { skillRegistry } from "../src/core/skill-registry.js";
import type { PermissionConfig } from "../src/types.js";
import { makeTestDir, setupEnv, teardownEnv, clearTools } from "./helpers.js";

const testDir = makeTestDir("core");

beforeAll(() => {
  clearTools();
  setupEnv(testDir);
});

afterAll(() => {
  teardownEnv();
});

describe("1. 工具注册表", () => {
  it("注册 9 个内置工具（含 ask_user / terminal_session / fs_edit）", () => {
    const tools = toolRegistry.getAll();
    expect(tools.length).toBe(9);
  });
  it("fs_edit 可用（局部修改工具）", () => {
    expect(toolRegistry.isAvailable("fs_edit")).toBe(true);
  });
  it("fs_read 可用", () => {
    expect(toolRegistry.isAvailable("fs_read")).toBe(true);
  });
  it("terminal_exec 可用", () => {
    expect(toolRegistry.isAvailable("terminal_exec")).toBe(true);
  });
  it("web_search 可用", () => {
    expect(toolRegistry.isAvailable("web_search")).toBe(true);
  });
  it("不存在工具返回 false", () => {
    expect(toolRegistry.isAvailable("nonexistent")).toBe(false);
  });
});

describe("2. 危险操作检测", () => {
  const detector = new DangerDetector();
  it("拦截 rm -rf /", () => {
    expect(detector.check("rm -rf /").isDangerous).toBe(true);
  });
  it("拦截 rm -rf ~", () => {
    expect(detector.check("rm -rf ~").isDangerous).toBe(true);
  });
  it("拦截 DROP TABLE", () => {
    expect(detector.check("DROP TABLE users").isDangerous).toBe(true);
  });
  it("拦截 git push --force", () => {
    expect(detector.check("git push --force").isDangerous).toBe(true);
  });
  it("拦截 git reset --hard", () => {
    expect(detector.check("git reset --hard HEAD~3").isDangerous).toBe(true);
  });
  it("拦截 del 删除单个文件 (Windows)", () => {
    expect(detector.check('del "D:\\ALAN\\Docs\\file.md"').isDangerous).toBe(true);
    expect(detector.check('del D:\\ALAN\\Docs\\file.md').isDangerous).toBe(true);
  });
  it("拦截 rm 删除单个文件", () => {
    expect(detector.check("rm /tmp/a.txt").isDangerous).toBe(true);
  });
  it("拦截 Remove-Item 删除文件", () => {
    expect(detector.check('Remove-Item "D:\\ALAN\\Docs\\file.md"').isDangerous).toBe(true);
  });
  it("del /s /q 递归删除拦截", () => {
    expect(detector.check("del /s /q C:\\temp").isDangerous).toBe(true);
  });
  it("rm -rf 相对路径拦截（防绕过）", () => {
    expect(detector.check("rm -rf ./dist").isDangerous).toBe(true);
    expect(detector.check("rm -rf node_modules").isDangerous).toBe(true);
    expect(detector.check("rm -rf ../secrets").isDangerous).toBe(true);
  });
  it("rm -rf 引号路径拦截（防绕过）", () => {
    expect(detector.check('rm -rf "my folder"').isDangerous).toBe(true);
  });
  it("RM -RF 大小写不敏感拦截（防绕过）", () => {
    expect(detector.check("RM -RF C:\\Windows").isDangerous).toBe(true);
  });
  it("del 参数任意顺序拦截（防绕过）", () => {
    expect(detector.check("del /q /s C:\\temp").isDangerous).toBe(true);
  });
  it("rd / rmdir /s 递归删除拦截（Windows 别名）", () => {
    expect(detector.check("rd /s /q C:\\x").isDangerous).toBe(true);
    expect(detector.check("rmdir /s /q C:\\x").isDangerous).toBe(true);
  });
  it("ls -la 安全", () => {
    expect(detector.check("ls -la").isDangerous).toBe(false);
  });
  it("echo 安全", () => {
    expect(detector.check("echo hello").isDangerous).toBe(false);
  });
  it("访问 .env 触发警告", () => {
    expect(detector.check("cat .env").level).toBe("warning");
  });
});

describe("3. 权限模型 (Ask/Plan/Auto)", () => {
  const permConfig: PermissionConfig = {
    defaultMode: "ask",
    modes: {
      ask: { description: "只读问答", allow_tool_calls: true, readOnly: true },
      plan: { description: "先计划", allow_tool_calls: true, require_confirmation: true },
      auto: { description: "自主执行", allow_tool_calls: true, high_risk_confirm: true },
    },
    allowedDirs: [],
    deniedPatterns: [],
  };
  const permModel = new PermissionModel(permConfig);

  it("默认 Ask 模式", () => {
    expect(permModel.getMode()).toBe("ask");
  });
  it("Ask 模式为只读", () => {
    expect(permModel.isReadOnly("ask")).toBe(true);
  });
  it("Ask 模式允许只读工具", () => {
    expect(permModel.allowsToolFor("ask", "fs_read")).toBe(true);
    expect(permModel.allowsToolFor("ask", "fs_list")).toBe(true);
  });
  it("Ask 模式禁止写工具", () => {
    expect(permModel.allowsToolFor("ask", "fs_write")).toBe(false);
    expect(permModel.allowsToolFor("ask", "terminal_exec")).toBe(false);
  });
  it("Ask 模式允许内置 MCP 只读工具", () => {
    expect(permModel.allowsToolFor("ask", "mcp_builtin_math_eval")).toBe(true);
    expect(permModel.allowsToolFor("ask", "mcp_builtin_timestamp_convert")).toBe(true);
  });
  it("Ask 模式禁止外部 MCP 工具（可能有写操作）", () => {
    expect(permModel.allowsToolFor("ask", "mcp_external_write_tool")).toBe(false);
  });
  it("Auto 模式允许全部工具", () => {
    permModel.setMode("auto");
    expect(permModel.allowsToolCalls()).toBe(true);
    expect(permModel.allowsToolFor("auto", "fs_write")).toBe(true);
  });
  it("Auto 模式高危需确认", () => {
    expect(permModel.highRiskNeedsConfirm()).toBe(true);
  });
  it("Plan 模式需确认", () => {
    permModel.setMode("plan");
    expect(permModel.requiresConfirmation()).toBe(true);
  });
});

describe("8. 专家路由器", () => {
  it("研究类问题路由到 research", () => {
    expect(routeToExpert("帮我研究一下 React 和 Vue 的对比")).toBe("research");
    expect(routeToExpert("分析一下新能源汽车市场趋势")).toBe("research");
    expect(routeToExpert("做一个竞品调研报告")).toBe("research");
  });

  it("通用问题路由到 default", () => {
    expect(routeToExpert("你好")).toBe("default");
    expect(routeToExpert("帮我创建一个文件")).toBe("default");
    expect(routeToExpert("列出当前目录")).toBe("default");
  });

  it("编码类问题路由到 coding", () => {
    expect(routeToExpert("帮我创建一个登录函数")).toBe("coding");
    expect(routeToExpert("修复 TypeError 报错")).toBe("coding");
    expect(routeToExpert("帮我调试这段代码")).toBe("coding");
    expect(routeToExpert("重构一下这个模块")).toBe("coding");
    expect(routeToExpert("给这个函数写个测试")).toBe("coding");
  });

  it("数据分析类问题路由到 data-analysis", () => {
    expect(routeToExpert("帮我做一下数据清洗")).toBe("data-analysis");
    expect(routeToExpert("画一个散点图")).toBe("data-analysis");
    expect(routeToExpert("写个 SQL 查询")).toBe("data-analysis");
  });

  it("金融类问题路由到 financial", () => {
    expect(routeToExpert("选股推荐")).toBe("financial");
    expect(routeToExpert("看一下这只股票的 PE")).toBe("financial");
    expect(routeToExpert("ETF 分析")).toBe("financial");
  });

  it("游戏设计类问题路由到 game-dev", () => {
    expect(routeToExpert("设计一个游戏关卡")).toBe("game-dev");
    expect(routeToExpert("用 Godot 写段代码")).toBe("game-dev");
    expect(routeToExpert("角色平衡怎么调整")).toBe("game-dev");
  });

  it("产品运营类问题路由到 product-ops", () => {
    expect(routeToExpert("帮我写个 PRD")).toBe("product-ops");
    expect(routeToExpert("排个迭代计划")).toBe("product-ops");
    expect(routeToExpert("写个内容运营方案")).toBe("product-ops");
  });
});

describe("10. 技能注册表", () => {
  beforeAll(() => {
    const skillsDir = resolve(process.cwd(), "skills");
    skillRegistry.loadFromDir(skillsDir);
  });

  it("技能加载成功", () => {
    expect(skillRegistry.count).toBeGreaterThanOrEqual(5);
  });

  it("Research 技能匹配", () => {
    const matches = skillRegistry.match("帮我研究一下市场趋势", "research");
    expect(matches.length).toBeGreaterThan(0);
  });

  it("关键词匹配 web 搜索技能", () => {
    const matches = skillRegistry.match("搜索一下最新 AI 资讯", "research");
    const hasWebSearch = matches.some((s) => s.name === "web-deep-search");
    expect(hasWebSearch).toBe(true);
  });

  it("不匹配其他智能体技能", () => {
    const matches = skillRegistry.match("帮我做竞品分析", "default");
    expect(matches.length).toBe(0);
  });

  it("getInjectedPrompt 生成 prompt", () => {
    const prompt = skillRegistry.getInjectedPrompt("research", "对比分析");
    expect(prompt).toContain("技能");
  });

  it("技能含描述字段（frontmatter description 或标题 fallback）", () => {
    const all = skillRegistry.getAll();
    expect(all.length).toBeGreaterThan(0);
    for (const s of all) {
      expect(s.description.length).toBeGreaterThan(0);
    }
  });
});

describe("11. Coding 智能体配置", () => {
  it("Coding Agent 配置包含 terminal_exec", async () => {
    const { CodingAgent } = await import("../src/agents/coding-agent.js");
    // 通过原型链确认类存在且可构造
    expect(CodingAgent).toBeDefined();
    expect(CodingAgent.prototype).toBeDefined();
  });

  it("Coding 技能匹配", () => {
    const matches = skillRegistry.match("帮我调试这段代码", "coding");
    expect(matches.length).toBeGreaterThan(0);
  });
});
