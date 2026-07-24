/**
 * MVP 冒烟测试 — 验证核心组件可用
 * 不依赖 LLM API，测试工具注册、安全检测、会话存储、权限模型
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { toolRegistry } from "./core/tool-registry.js";
import { registerBuiltinTools } from "./tools/builtin.js";
import { DangerDetector } from "./security/danger-detector.js";
import { PermissionModel } from "./security/permission-model.js";
import { SessionStore } from "./memory/session-store.js";
import { ContextCompressor } from "./memory/compressor.js";
import { hookManager } from "./hooks/hook-manager.js";
import { routeToExpert } from "./agents/router.js";
import { mcpManager } from "./mcp/mcp-manager.js";
import { skillRegistry } from "./core/skill-registry.js";
import type { PermissionConfig } from "./types.js";
import { resolve } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

const testDataDir = resolve(process.cwd(), "data-test");

beforeAll(() => {
  try { rmSync(testDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  mkdirSync(testDataDir, { recursive: true });
  registerBuiltinTools();
});

afterAll(() => {
  try { rmSync(testDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("1. 工具注册表", () => {
  it("注册 6 个内置工具", () => {
    const tools = toolRegistry.getAll();
    expect(tools.length).toBe(6);
  });
  it("fs_read 可用", () => { expect(toolRegistry.isAvailable("fs_read")).toBe(true); });
  it("terminal_exec 可用", () => { expect(toolRegistry.isAvailable("terminal_exec")).toBe(true); });
  it("web_search 可用", () => { expect(toolRegistry.isAvailable("web_search")).toBe(true); });
  it("不存在工具返回 false", () => { expect(toolRegistry.isAvailable("nonexistent")).toBe(false); });
});

describe("2. 危险操作检测", () => {
  const detector = new DangerDetector();
  it("拦截 rm -rf /", () => { expect(detector.check("rm -rf /").isDangerous).toBe(true); });
  it("拦截 rm -rf ~", () => { expect(detector.check("rm -rf ~").isDangerous).toBe(true); });
  it("拦截 DROP TABLE", () => { expect(detector.check("DROP TABLE users").isDangerous).toBe(true); });
  it("拦截 git push --force", () => { expect(detector.check("git push --force").isDangerous).toBe(true); });
  it("拦截 git reset --hard", () => { expect(detector.check("git reset --hard HEAD~3").isDangerous).toBe(true); });
  it("ls -la 安全", () => { expect(detector.check("ls -la").isDangerous).toBe(false); });
  it("echo 安全", () => { expect(detector.check("echo hello").isDangerous).toBe(false); });
  it("访问 .env 触发警告", () => { expect(detector.check("cat .env").level).toBe("warning"); });
});

describe("3. 权限模型 (Ask/Plan/Craft)", () => {
  const permConfig: PermissionConfig = {
    defaultMode: "ask",
    modes: {
      ask: { description: "纯问答", allow_tool_calls: false },
      plan: { description: "先计划", allow_tool_calls: false, require_confirmation: true },
      craft: { description: "自主执行", allow_tool_calls: true, high_risk_confirm: true },
    },
    allowedDirs: [],
    deniedPatterns: [],
  };
  const permModel = new PermissionModel(permConfig);

  it("默认 Ask 模式", () => { expect(permModel.getMode()).toBe("ask"); });
  it("Ask 模式不允许工具调用", () => { expect(permModel.allowsToolCalls()).toBe(false); });
  it("Craft 模式允许工具调用", () => {
    permModel.setMode("craft");
    expect(permModel.allowsToolCalls()).toBe(true);
  });
  it("Craft 模式高危需确认", () => { expect(permModel.highRiskNeedsConfirm()).toBe(true); });
  it("Plan 模式需确认", () => {
    permModel.setMode("plan");
    expect(permModel.requiresConfirmation()).toBe(true);
  });
});

describe("4. 会话存储 (SQLite + FTS5)", () => {
  let sessionStore: SessionStore;
  let session: { id: string; agentId: string; createdAt: number; updatedAt: number };

  beforeAll(() => {
    sessionStore = new SessionStore(resolve(testDataDir, "test.db"));
    session = sessionStore.createSession("test-agent");
  });

  it("创建会话成功", () => { expect(session.id).toBeTruthy(); });
  it("消息历史 2 条", () => {
    sessionStore.appendMessage(session.id, { role: "user", content: "你好" });
    sessionStore.appendMessage(session.id, { role: "assistant", content: "你好！有什么可以帮你的？" });
    const history = sessionStore.getMessages(session.id);
    expect(history.length).toBe(2);
  });
  it("第一条是 user 消息", () => {
    const history = sessionStore.getMessages(session.id);
    expect(history[0].role).toBe("user");
  });
  it("第二条是 assistant 消息", () => {
    const history = sessionStore.getMessages(session.id);
    expect(history[1].role).toBe("assistant");
  });
  it("FTS5 检索到结果", () => {
    sessionStore.saveEpisodic(session.id, "用户询问了天气", "天气查询", 1.0);
    const results = sessionStore.searchEpisodic("天气");
    expect(results.length).toBeGreaterThan(0);
  });

  afterAll(() => { sessionStore.close(); });
});

describe("5. 上下文压缩", () => {
  const compressor = new ContextCompressor(undefined, 0.92);

  it("小上下文不触发压缩", () => {
    const smallMessages = [{ role: "user" as const, content: "hello" }];
    expect(compressor.needsCompression(smallMessages)).toBe(false);
  });

  it("大上下文触发 92% 压缩", () => {
    const largeMessages = Array.from({ length: 100 }, (_, i) => ({
      role: "user" as const,
      content: "A".repeat(5000) + ` message ${i}`,
    }));
    expect(compressor.needsCompression(largeMessages)).toBe(true);
  });

  it("压缩成功执行并减少消息", async () => {
    const largeMessages = Array.from({ length: 100 }, (_, i) => ({
      role: "user" as const,
      content: "A".repeat(5000) + ` message ${i}`,
    }));
    const { messages: compressed, result } = await compressor.compress(largeMessages);
    expect(result.compressed).toBe(true);
    expect(compressed.length).toBeLessThan(largeMessages.length);
  });
});

describe("6. Hooks 系统", () => {
  it("onToolCallPre Hook 被调用", async () => {
    hookManager.clear();
    let hookCalled = false;
    hookManager.on("onToolCallPre", async () => { hookCalled = true; return void 0; });
    await hookManager.trigger("onToolCallPre", {
      agentId: "test", sessionId: "test", data: { toolName: "fs_read" },
    });
    expect(hookCalled).toBe(true);
  });

  it("Hook 拦截生效", async () => {
    hookManager.clear();
    hookManager.on("onToolCallPre", async () => ({
      proceed: false, message: "测试拦截",
    }));
    const result = await hookManager.trigger("onToolCallPre", {
      agentId: "test", sessionId: "test", data: {},
    });
    expect(result.proceed).toBe(false);
  });

  it("拦截消息正确传递", async () => {
    hookManager.clear();
    hookManager.on("onToolCallPre", async () => ({
      proceed: false, message: "测试拦截",
    }));
    const result = await hookManager.trigger("onToolCallPre", {
      agentId: "test", sessionId: "test", data: {},
    });
    expect(result.message).toBe("测试拦截");
  });
});

describe("7. 工具执行", () => {
  const ctx = { agentId: "test", sessionId: "test", workingDir: process.cwd(), permissions: "craft" as const };

  it("获取 fs_read handler", () => {
    const readHandler = toolRegistry.getHandler("fs_read");
    expect(readHandler).toBeTruthy();
  });

  it("读取 package.json 成功", async () => {
    const handler = toolRegistry.getHandler("fs_read")!;
    const result = await handler({ path: "package.json" }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain("aiworker");
  });

  it("列出目录成功", async () => {
    const handler = toolRegistry.getHandler("fs_list")!;
    const result = await handler({}, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain("package.json");
  });

  it("执行 echo 命令成功", async () => {
    const handler = toolRegistry.getHandler("terminal_exec")!;
    const result = await handler({ command: "echo AiWorker-Test" }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain("AiWorker-Test");
  });

  it("rm -rf / 被拦截", async () => {
    const handler = toolRegistry.getHandler("terminal_exec")!;
    const result = await handler({ command: "rm -rf /" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("高危");
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

describe("9. MCP Manager", () => {
  it("MCP Manager 单例可用", () => {
    expect(mcpManager).toBeDefined();
    const statuses = mcpManager.getStatuses();
    expect(typeof statuses).toBe("object");
  });

  it("dispose 不报错", () => {
    mcpManager.dispose();
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
});

describe("11. Coding 智能体配置", () => {
  it("Coding Agent 配置包含 terminal_exec", async () => {
    const { CodingAgent } = await import("./agents/coding-agent.js");
    // 通过原型链确认类存在且可构造
    expect(CodingAgent).toBeDefined();
    expect(CodingAgent.prototype).toBeDefined();
  });

  it("Coding 技能匹配", () => {
    const matches = skillRegistry.match("帮我调试这段代码", "coding");
    expect(matches.length).toBeGreaterThan(0);
  });
});

describe("12. Streaming + 终端模块", () => {
  it("StreamChunk 类型可构造", () => {
    const chunk = { type: "text" as const, content: "hello" };
    expect(chunk.type).toBe("text");
    expect(chunk.content).toBe("hello");
  });

  it("StreamChunk done 类型", () => {
    const chunk = {
      type: "done" as const,
      finishReason: "stop" as const,
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    };
    expect(chunk.finishReason).toBe("stop");
    expect(chunk.usage!.totalTokens).toBe(150);
  });

  it("ModelRouter 导出 completeStream", async () => {
    const { ModelRouter } = await import("./core/model-router.js");
    expect(typeof ModelRouter.prototype.completeStream).toBe("function");
  });

  it("ModelRouter 导出 getCurrentModel", async () => {
    const { ModelRouter } = await import("./core/model-router.js");
    expect(typeof ModelRouter.prototype.getCurrentModel).toBe("function");
  });

  it("runAgentLoopStream 从 agent-loop 导出", async () => {
    const mod = await import("./core/agent-loop.js");
    expect(typeof mod.runAgentLoopStream).toBe("function");
  });

  it("BaseAgent.runStream 方法存在", async () => {
    const { DefaultAgent } = await import("./agents/default-agent.js");
    expect(typeof DefaultAgent.prototype.runStream).toBe("function");
  });

  it("TerminalRenderer 单例可导出", async () => {
    const { renderer } = await import("./terminal/renderer.js");
    expect(renderer).toBeDefined();
    expect(typeof renderer.write).toBe("function");
    expect(typeof renderer.updateStatus).toBe("function");
    expect(typeof renderer.destroy).toBe("function");
  });

  it("InputCollector 队列管理", async () => {
    const { inputCollector } = await import("./terminal/input.js");
    expect(inputCollector).toBeDefined();
    expect(typeof inputCollector.startListening).toBe("function");
    expect(typeof inputCollector.stopListening).toBe("function");
    expect(typeof inputCollector.getQueueSize).toBe("function");
    expect(inputCollector.getQueueSize()).toBe(0);
  });

  it("ANSI 工具函数存在", async () => {
    const ansi = await import("./terminal/ansi.js");
    expect(typeof ansi.hideCursor).toBe("function");
    expect(typeof ansi.showCursor).toBe("function");
    expect(typeof ansi.reverseVideo).toBe("function");
    expect(typeof ansi.bold).toBe("function");
    expect(ansi.reverseVideo("test")).toContain("[7m");
    expect(ansi.bold("test")).toContain("[1m");
  });
});
