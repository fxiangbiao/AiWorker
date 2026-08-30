/**
 * 通用智能体 — 自定义智能体的运行时载体
 * 配置来自 config/agents/<id>.yaml（skills/mcpServers/plugins 绑定见 BaseAgent 装配）
 */

import { BaseAgent } from "./base-agent.js";
import type { AgentConfig } from "../types.js";

export class GenericAgent extends BaseAgent {
  constructor(config: AgentConfig, deps: ConstructorParameters<typeof BaseAgent>[1]) {
    super(config, deps);
  }
}
