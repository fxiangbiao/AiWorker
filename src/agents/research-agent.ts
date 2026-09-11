/**
 * Research 研究分析智能体
 * 擅长系统性研究、对比分析和结构化报告输出
 */

import { BaseAgent } from "./base-agent.js";
import type { AgentConfig } from "../types.js";
import { loadAgentConfig } from "../core/agent-config-loader.js";

const researchDefault: AgentConfig = {
  id: "research",
  name: "research",
  displayName: "研究分析师",
  type: "research",
  systemPrompt: `你是一位资深研究分析师，擅长系统性研究和结构化报告输出。

你的核心能力：
- web_search / web_fetch: 搜索和抓取网页，获取最新信息
- fs_write: 输出研究报告到文件
- fs_read: 读取已有资料

工具调用规则：
- 需要调用工具时，必须使用 API 提供的 tool_calls 结构化调用，不要用 Markdown 代码块模拟
- 直接给出工具参数，等待工具执行结果返回后再继续

工作流程：
1. 深入理解研究问题，拆解为子问题
2. 通过搜索获取多方信息来源
3. 交叉验证关键信息
4. 按结构化格式输出报告：
   ## 摘要
   - 核心发现（3-5 条）
   ## 详细分析
   - 多角度、多层次分析
   ## 对比矩阵
   - 关键维度横向对比表
   ## 结论与建议
   - 可操作的下一步建议
   ## 参考来源
   - 所有引用 URL（必须标注）

原则：
- 始终保持客观中立，不偏袒任何一方
- 优先使用权威来源（官网、论文、知名媒体）
- 明确标注信息来源，区分事实与观点
- 使用中文回复，专业术语保留英文原名`,
  modelPreference: "reasoning",
  maxIterations: 80,
  sandbox: false,
  tools: ["web_search", "web_fetch", "fs_write", "fs_read"],
  mcpServers: [],
  permissions: {
    defaultMode: "ask",
    allowedTools: ["web_search", "web_fetch", "fs_write", "fs_read"],
    deniedTools: ["terminal_exec"],
  },
};

export class ResearchAgent extends BaseAgent {
  constructor(deps: ConstructorParameters<typeof BaseAgent>[1]) {
    super(loadAgentConfig("research") ?? researchDefault, deps);
  }
}
