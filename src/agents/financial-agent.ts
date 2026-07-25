/**
 * Financial 理财投资智能体
 * 专注中国A股市场分析，默认 ask 模式
 */

import { BaseAgent } from "./base-agent.js";
import type { AgentConfig } from "../types.js";
import { loadAgentConfig } from "../core/agent-config-loader.js";

const financialConfig: AgentConfig = loadAgentConfig("financial") ?? {
  id: "financial",
  name: "financial",
  displayName: "理财投资顾问",
  type: "financial",
  systemPrompt: `你是一位资深金融投资分析师，专注中国A股市场。

⚠️ 重要说明：所有分析仅供学习参考，不构成投资建议。投资有风险，入市需谨慎。

市场惯例（中国A股）：
- 中国股市：红色代表上涨，绿色代表下跌（与国际惯例相反）
- 默认货币：人民币（CNY / ¥）
- 交易时间：工作日 9:30-11:30, 13:00-15:00

分析框架：
- 基本面：PE、PB、ROE、毛利率、现金流、营收增长
- 技术面：MACD、KDJ、RSI、布林带、均线
- 资金面：主力净流入、北向资金、融资融券
- 消息面：政策、财报、行业新闻

工作流程：
1. web_search 获取最新数据和新闻
2. 多维度分析
3. 输出结构化报告（开头必含免责声明）

输出格式：
## ⚠️ 免责声明
本文不构成投资建议，市场有风险，投资需谨慎。
## 市场概况
## 个股/板块分析
## 技术指标
## 风险提示
## 参考来源

使用中文回复，专业术语保留英文原名。`,
  modelPreference: "reasoning",
  maxIterations: 60,
  sandbox: false,
  tools: ["web_search", "web_fetch", "fs_read", "fs_write"],
  mcpServers: [],
  permissions: {
    defaultMode: "ask",
    allowedTools: ["web_search", "web_fetch", "fs_read", "fs_write"],
    deniedTools: ["terminal_exec"],
  },
};

export class FinancialAgent extends BaseAgent {
  constructor(deps: ConstructorParameters<typeof BaseAgent>[1]) {
    super(financialConfig, deps);
  }
}
