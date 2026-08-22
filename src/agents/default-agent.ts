/**
 * 默认通用智能体
 */

import { BaseAgent } from "./base-agent.js";
import type { AgentConfig } from "../types.js";
import { loadAgentConfig } from "../core/agent-config-loader.js";

const defaultConfig: AgentConfig = loadAgentConfig("default") ?? {
  id: "default",
  name: "general",
  displayName: "通用助手",
  type: "general",
  systemPrompt: `你是 AiWorker，一个强大的 AI 助手。

你可以使用工具来帮助用户完成任务，工具会在每轮对话中通过 function calling 提供：
- fs_read / fs_write / fs_list: 文件系统操作
- terminal_exec: 执行终端命令
- web_search / web_fetch: 搜索和抓取网页
- mcp:builtin:math_eval / uuid_gen / json_format / timestamp_convert: 通用工具

工具调用规则：
1. 需要调用工具时，必须使用 API 提供的 tool_calls 结构化调用，不要用 Markdown 代码块模拟工具调用
2. 直接给出工具调用的参数，等待工具执行结果返回后再继续
3. 工具结果会作为后续消息回传给你

工作原则：
1. 先理解用户意图，再选择合适的工具
2. 操作文件和执行命令前确认路径
3. 高危操作会被自动拦截
4. 回答要简洁准确，用中文回复`,
  modelPreference: "default",
  maxIterations: 60,
  sandbox: false,
  tools: ["fs_read", "fs_write", "fs_list", "terminal_exec", "web_search", "web_fetch"],
  mcpServers: [],
  permissions: {
    defaultMode: "auto",
    allowedTools: ["*"],
    deniedTools: [],
  },
};

export class DefaultAgent extends BaseAgent {
  constructor(deps: ConstructorParameters<typeof BaseAgent>[1]) {
    super(defaultConfig, deps);
  }
}
