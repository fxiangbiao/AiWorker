/**
 * CLI 命令契约 — 注册表分发 + 显式命令上下文（方案 A：完整命令模块化）
 * 命令 handler 不再捕获 index.ts 闭包，所有可变状态/服务/输出经 CommandContext 注入，可独立单测
 */

import type { PermissionMode, ContextBreakdown } from "../types.js";
import type { ModelRouter } from "../core/model-router.js";
import type { SessionStore } from "../memory/session-store.js";
import type { TeamCoordinator } from "../core/team-coordinator.js";
import type { BaseAgent } from "../agents/base-agent.js";
import type { AppManager } from "../core/app-manager.js";
import type { AppFactory } from "../core/app-factory.js";

export type CommandAction = "continue" | "exit";

/** 命令执行上下文：会话内可变状态 + 服务引用 + 输出抽象（由 index.ts 组装注入） */
export interface CommandContext {
  // 会话状态
  mode: () => PermissionMode;
  setMode: (m: PermissionMode) => void;
  showThinking: () => boolean;
  toggleThinking: () => void;
  currentSessionId: () => string | undefined;
  setCurrentSessionId: (id: string | undefined) => void;
  /** 排队消息（/skill 激活后 push，主循环顶部自动消费走路由） */
  prefillQueue: string[];
  /** 上次回答原始文本（/copy 读取，路由执行处写入） */
  lastAnswer: { value: string };
  // 服务
  agents: Record<string, BaseAgent>;
  /** 当前路由专家（/config iterations 用；index.ts 注入 routeToExpert("") 语义） */
  currentAgent: () => BaseAgent;
  /** 保存智能体配置（写 config/agents/<id>.yaml + 热重载；注入后 /config iterations 持久化，否则仅内存生效） */
  saveAgentConfig?: (cfg: import("../types.js").AgentConfig) => { ok: boolean; error?: string };
  coordinator: TeamCoordinator;
  modelRouter: ModelRouter;
  sessionStore: SessionStore;
  skillCount: number;
  /** 工作目录（读写统一基准） */
  workingDir: string;
  /** 数据目录（会话/审计/引导标记等） */
  dataDir: string;
  runtimeConfigPath: string;
  persistRuntimeConfig: () => void;
  /** 上下文分层统计（封装 ContextManager + 路由到当前 agent） */
  getContextBreakdown: (query: string) => ContextBreakdown;
  /** 全部已注册命令（/help 生成表格用；index.ts 组装后注入） */
  listCommands: () => CliCommand[];
  /** 应用管理器（/app 命令用；未注入则该命令提示不可用） */
  appManager?: AppManager;
  /** 应用工厂（/app new|update 用；未注入则提示不可用） */
  appFactory?: AppFactory;
  // 输出抽象（测试可捕获）
  write: (text: string) => void;
  writeLine: (line: string) => void;
  printStatus: () => void;
  /** 提问通道（/setup 引导用；TUI 走输入行，无 TUI 返回 null） */
  ask: (question: string) => Promise<string | null>;
}

/** CLI 命令（数组顺序 = 匹配优先级 + /help 展示顺序） */
export interface CliCommand {
  name: string;
  aliases?: string[];
  /** /help 第一列（含参数示例） */
  usage: string;
  /** /help 第二列 */
  description: string;
  /** /help 第三列 */
  detail: string;
  handler: (ctx: CommandContext, arg: string, line: string) => Promise<CommandAction>;
}
