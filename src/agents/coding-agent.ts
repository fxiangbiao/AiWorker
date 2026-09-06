/**
 * Coding 编码智能体
 * 擅长架构设计、代码重构、调试排错、测试生成
 */

import { BaseAgent } from "./base-agent.js";
import type { AgentConfig } from "../types.js";
import { loadAgentConfig } from "../core/agent-config-loader.js";

const codingDefault: AgentConfig = {
  id: "coding",
  name: "coding",
  displayName: "编码工程师",
  type: "coding",
  systemPrompt: `你是一位全栈高级工程师，擅长架构设计、代码重构、调试排错和单元测试。

你的核心能力：
- fs_read / fs_write / fs_list: 文件系统操作
- terminal_exec: 执行终端命令（编译、运行测试、包管理、Git 等）；写文件请用 fs_write
- web_search: 搜索技术文档和解决方案

工具调用规则：
- 需要调用工具时，必须使用 API 提供的 tool_calls 结构化调用，不要用 Markdown 代码块模拟
- 直接给出工具参数，等待工具执行结果返回后再继续

工作原则：
1. 先阅读项目现有代码 — 用 fs_read 理解代码结构和风格后再动手
2. 保持代码风格一致 — 遵循项目已有的命名、缩进、注释风格
3. 小步提交验证 — 每次改动后运行相关测试，确保不破坏已有功能
4. 优先最小改动 — 用最简单的方案解决问题，不做过度重构
5. 安全第一 — 禁止执行 rm/git reset --hard 等不可逆操作

输出要求：
- 代码修改前先说明改什么、为什么
- 修改后列出变更的文件和行数
- 发现 bug 时先分析根因再修复
- 使用中文回复`,
  modelPreference: "coding",
  maxIterations: 50,
  sandbox: false,
  tools: ["fs_read", "fs_write", "fs_list", "terminal_exec", "web_search"],
  mcpServers: [],
  permissions: {
    defaultMode: "auto",
    allowedTools: ["fs_read", "fs_write", "fs_list", "terminal_exec", "web_search"],
    deniedTools: [],
  },
};

export class CodingAgent extends BaseAgent {
  constructor(deps: ConstructorParameters<typeof BaseAgent>[1]) {
    // 每次构造重读 YAML（保存后 reloadAgent → new → 最新配置生效，避免模块级一次性加载缓存旧值）
    super(loadAgentConfig("coding") ?? codingDefault, deps);
  }
}
