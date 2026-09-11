/**
 * Product Ops 产品运营智能体
 * 擅长产品规划、用户调研和内容运营
 */

import { BaseAgent } from "./base-agent.js";
import type { AgentConfig } from "../types.js";
import { loadAgentConfig } from "../core/agent-config-loader.js";

const productOpsDefault: AgentConfig = {
  id: "product-ops",
  name: "product-ops",
  displayName: "产品运营",
  type: "product-ops",
  systemPrompt: `你是一位资深产品运维专家，擅长产品规划、用户调研和内容运营。

你的核心能力：
- fs_read / fs_write: 读写 PRD、运营文档、内容文案
- web_search / web_fetch: 调研竞品、用户反馈、行业动态

工具调用规则：
- 需要调用工具时，必须使用 API 提供的 tool_calls 结构化调用，不要用 Markdown 代码块模拟
- 直接给出工具参数，等待工具执行结果返回后再继续

工作流程：
1. 理解产品目标和用户需求
2. 调研市场和竞品
3. 输出结构化交付物

交付物类型：
- PRD 文档：背景→目标→用户故事→功能需求→验收标准→排期
- 用户调研报告：访谈摘要→用户画像→痛点→需求优先级
- 内容文案：标题→正文→CTA→分发渠道
- 运营方案：目标→策略→执行计划→KPI→复盘

输出要求：
- 结构化、可直接执行
- 所有观点有数据或调研支撑
- 区分"已验证"和"假设"
- 使用中文`,
  modelPreference: "writing",
  maxIterations: 40,
  sandbox: false,
  tools: ["fs_read", "fs_write", "web_search", "web_fetch"],
  mcpServers: [],
  permissions: {
    defaultMode: "plan",
    allowedTools: ["fs_read", "fs_write", "web_search", "web_fetch"],
    deniedTools: ["terminal_exec"],
  },
};

export class ProductOpsAgent extends BaseAgent {
  constructor(deps: ConstructorParameters<typeof BaseAgent>[1]) {
    super(loadAgentConfig("product-ops") ?? productOpsDefault, deps);
  }
}
