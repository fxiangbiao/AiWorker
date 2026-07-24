/**
 * MVP 冒烟测试 — 验证核心组件可用
 * 不依赖 LLM API，测试工具注册、安全检测、会话存储、权限模型
 */

import { toolRegistry } from "./core/tool-registry.js";
import { registerBuiltinTools } from "./tools/builtin.js";
import { DangerDetector } from "./security/danger-detector.js";
import { PermissionModel } from "./security/permission-model.js";
import { SessionStore } from "./memory/session-store.js";
import { ContextCompressor } from "./memory/compressor.js";
import { hookManager } from "./hooks/hook-manager.js";
import type { PermissionConfig } from "./types.js";
import { resolve } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

const testDataDir = resolve(process.cwd(), "data-test");
// 清理旧的测试数据
try { rmSync(testDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
mkdirSync(testDataDir, { recursive: true });

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    failed++;
  }
}

console.log("\n🧪 AiWorker MVP 冒烟测试\n");

// 1. 工具注册表
console.log("1. 工具注册表");
registerBuiltinTools();
const tools = toolRegistry.getAll();
assert(tools.length === 6, `注册 6 个内置工具 (实际: ${tools.length})`);
assert(toolRegistry.isAvailable("fs_read"), "fs_read 可用");
assert(toolRegistry.isAvailable("terminal_exec"), "terminal_exec 可用");
assert(toolRegistry.isAvailable("web_search"), "web_search 可用");
assert(!toolRegistry.isAvailable("nonexistent"), "不存在工具返回 false");

// 2. 危险检测器
console.log("\n2. 危险操作检测");
const detector = new DangerDetector();
assert(detector.check("rm -rf /").isDangerous, "拦截 rm -rf /");
assert(detector.check("rm -rf ~").isDangerous, "拦截 rm -rf ~");
assert(detector.check("DROP TABLE users").isDangerous, "拦截 DROP TABLE");
assert(detector.check("git push --force").isDangerous, "拦截 git push --force");
assert(detector.check("git reset --hard HEAD~3").isDangerous, "拦截 git reset --hard");
assert(!detector.check("ls -la").isDangerous, "ls -la 安全");
assert(!detector.check("echo hello").isDangerous, "echo 安全");
assert(detector.check("cat .env").level === "warning", "访问 .env 触发警告");

// 3. 权限模型
console.log("\n3. 权限模型 (Ask/Plan/Craft)");
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
assert(permModel.getMode() === "ask", "默认 Ask 模式");
assert(!permModel.allowsToolCalls(), "Ask 模式不允许工具调用");
permModel.setMode("craft");
assert(permModel.allowsToolCalls(), "Craft 模式允许工具调用");
assert(permModel.highRiskNeedsConfirm(), "Craft 模式高危需确认");
permModel.setMode("plan");
assert(permModel.requiresConfirmation(), "Plan 模式需确认");

// 4. 会话存储
console.log("\n4. 会话存储 (SQLite + FTS5)");
const sessionStore = new SessionStore(resolve(testDataDir, "test.db"));
const session = sessionStore.createSession("test-agent");
assert(!!session.id, `创建会话: ${session.id}`);
sessionStore.appendMessage(session.id, { role: "user", content: "你好" });
sessionStore.appendMessage(session.id, { role: "assistant", content: "你好！有什么可以帮你的？" });
const history = sessionStore.getMessages(session.id);
assert(history.length === 2, `消息历史 2 条 (实际: ${history.length})`);
assert(history[0].role === "user", "第一条是 user 消息");
assert(history[1].role === "assistant", "第二条是 assistant 消息");

// FTS5 测试
sessionStore.saveEpisodic(session.id, "用户询问了天气", "天气查询", 1.0);
const results = sessionStore.searchEpisodic("天气");
assert(results.length > 0, `FTS5 检索到结果 (实际: ${results.length})`);
sessionStore.close();

// 5. 上下文压缩器
console.log("\n5. 上下文压缩");
const compressor = new ContextCompressor(undefined, 0.92);
const smallMessages = [{ role: "user" as const, content: "hello" }];
assert(!compressor.needsCompression(smallMessages), "小上下文不触发压缩");

// 构造大上下文
const largeMessages = Array.from({ length: 100 }, (_, i) => ({
  role: "user" as const,
  content: "A".repeat(5000) + ` message ${i}`,
}));
assert(compressor.needsCompression(largeMessages), "大上下文触发 92% 压缩");
const { messages: compressed, result } = await compressor.compress(largeMessages);
assert(result.compressed, "压缩成功执行");
assert(compressed.length < largeMessages.length, `压缩后消息减少 (${largeMessages.length} → ${compressed.length})`);

// 6. Hooks 系统
console.log("\n6. Hooks 系统");
hookManager.clear();
let hookCalled = false;
hookManager.on("onToolCallPre", async (ctx) => {
  hookCalled = true;
  return void 0;
});
await hookManager.trigger("onToolCallPre", {
  agentId: "test",
  sessionId: "test",
  data: { toolName: "fs_read" },
});
assert(hookCalled, "onToolCallPre Hook 被调用");

// 测试 Hook 拦截
hookManager.clear();
hookManager.on("onToolCallPre", async () => ({
  proceed: false,
  message: "测试拦截",
}));
const blockResult = await hookManager.trigger("onToolCallPre", {
  agentId: "test",
  sessionId: "test",
  data: {},
});
assert(!blockResult.proceed, "Hook 拦截生效");
assert(blockResult.message === "测试拦截", "拦截消息正确传递");

// 7. 工具执行测试
console.log("\n7. 工具执行");
const readHandler = toolRegistry.getHandler("fs_read");
assert(!!readHandler, "获取 fs_read handler");

if (readHandler) {
  const result = await readHandler(
    { path: "package.json" },
    { agentId: "test", sessionId: "test", workingDir: process.cwd(), permissions: "craft" }
  );
  assert(result.success, "读取 package.json 成功");
  assert(result.content.includes("aiworker"), "内容包含 aiworker");
}

const listHandler = toolRegistry.getHandler("fs_list");
if (listHandler) {
  const result = await listHandler(
    {},
    { agentId: "test", sessionId: "test", workingDir: process.cwd(), permissions: "craft" }
  );
  assert(result.success, "列出目录成功");
  assert(result.content.includes("package.json"), "目录包含 package.json");
}

const execHandler = toolRegistry.getHandler("terminal_exec");
if (execHandler) {
  const result = await execHandler(
    { command: "echo AiWorker-Test" },
    { agentId: "test", sessionId: "test", workingDir: process.cwd(), permissions: "craft" }
  );
  assert(result.success, "执行 echo 命令成功");
  assert(result.content.includes("AiWorker-Test"), "命令输出正确");
}

// 危险命令拦截
if (execHandler) {
  const result = await execHandler(
    { command: "rm -rf /" },
    { agentId: "test", sessionId: "test", workingDir: process.cwd(), permissions: "craft" }
  );
  assert(!result.success, "rm -rf / 被拦截");
  assert(result.error?.includes("高危") ?? false, "拦截消息包含高危提示");
}

// 清理
try { rmSync(testDataDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log("\n" + "═".repeat(50));
console.log(`  结果: ${passed} 通过, ${failed} 失败`);
console.log("═".repeat(50));

if (failed > 0) {
  process.exit(1);
}
