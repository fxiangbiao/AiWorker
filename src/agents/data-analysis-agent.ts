/**
 * Data Analysis 数据分析智能体
 * 擅长数据清洗、统计建模和可视化
 */

import { BaseAgent } from "./base-agent.js";
import type { AgentConfig } from "../types.js";
import { loadAgentConfig } from "../core/agent-config-loader.js";

const dataAnalysisConfig: AgentConfig = loadAgentConfig("data-analysis") ?? {
  id: "data-analysis",
  name: "data-analysis",
  displayName: "数据分析师",
  type: "data-analysis",
  systemPrompt: `你是一位资深数据分析师，擅长数据清洗、统计建模和可视化。

你的核心能力：
- fs_read / fs_write: 读取和写入数据文件（CSV、JSON 等）
- terminal_exec: 运行 Python 脚本（pandas/numpy/matplotlib）；写脚本/数据文件用 fs_write
- web_search: 搜索数据分析方法和最佳实践

工具调用规则：
- 需要调用工具时，必须使用 API 提供的 tool_calls 结构化调用，不要用 Markdown 代码块模拟
- 直接给出工具参数，等待工具执行结果返回后再继续

工作流程：
1. 理解数据源和业务问题
2. 读取数据结构，识别字段类型
3. 数据清洗：缺失值、异常值、格式统一
4. 探索性分析：描述性统计、分布、相关性
5. 建模分析（如适用）
6. 可视化呈现关键发现

Python 分析环境使用 terminal_exec 执行脚本，可用库：pandas、numpy、matplotlib、scipy。

输出要求：
- 数据概况（行数、列数、类型、缺失率）
- 关键指标统计
- 可视化图表
- 结论与建议
- 使用中文回复`,
  modelPreference: "coding",
  maxIterations: 60,
  sandbox: false,
  tools: ["fs_read", "fs_write", "fs_list", "terminal_exec", "web_search"],
  mcpServers: [],
  permissions: {
    defaultMode: "auto",
    allowedTools: ["fs_read", "fs_write", "fs_list", "terminal_exec", "web_search"],
    deniedTools: [],
  },
};

export class DataAnalysisAgent extends BaseAgent {
  constructor(deps: ConstructorParameters<typeof BaseAgent>[1]) {
    super(dataAnalysisConfig, deps);
  }
}
