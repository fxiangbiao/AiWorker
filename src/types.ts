/**
 * AiWorker 核心类型定义
 * 基于 OpenAI 标准 message 格式，保证多模型切换零摩擦
 */

// ===== 消息与对话 =====

export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ToolResult {
  tool_call_id: string;
  content: string;
  success: boolean;
  error?: string;
}

// ===== 工具定义 =====

export interface ToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  required?: string[];
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolParameter;
  };
}

export interface ToolContext {
  agentId: string;
  sessionId: string;
  workingDir: string;
  projectDir: string;
  permissions: PermissionMode;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
  enabled: boolean;
  /** 运行时可用性检查，返回 false 则该工具在本次调用中不可见 */
  availabilityCheck?: (ctx: ToolContext) => boolean | Promise<boolean>;
}

// ===== 模型接口 =====

export interface ModelCompleteOptions {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  hasToolCalls: boolean;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: "stop" | "tool_calls" | "length" | "content_filter";
}

export type ModelProvider = (options: ModelCompleteOptions) => Promise<ModelResponse>;

// ===== Streaming 响应 =====

export interface StreamChunk {
  type: "text" | "thinking" | "tool_call_start" | "tool_call_delta" | "tool_call_done" | "done" | "error";
  content?: string;
  toolCallId?: string;
  toolName?: string;
  finishReason?: "stop" | "tool_calls" | "length" | "content_filter";
  error?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface StreamCallbacks {
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onThinkingStart?: () => void;
  onToolCall?: (name: string, args: string, id: string) => void;
  onToolResult?: (name: string, success: boolean, summary: string) => void;
  onStepStart?: (stepId: string, expertId: string, desc: string) => void;
  onStepEnd?: (stepId: string, success: boolean) => void;
  onFileDiff?: (filePath: string, added: number, removed: number) => void;
}

// ===== 智能体 =====

export type PermissionMode = "ask" | "plan" | "craft";

export interface PermissionConfig {
  defaultMode: PermissionMode;
  modes: Record<
    PermissionMode,
    {
      description: string;
      allow_tool_calls: boolean;
      require_confirmation?: boolean;
      high_risk_confirm?: boolean;
    }
  >;
  allowedDirs: string[];
  deniedPatterns: string[];
}

export interface AgentConfig {
  id: string;
  name: string;
  displayName: string;
  type: string;
  systemPrompt: string;
  modelPreference: string; // coding | reasoning | writing | creative | lite
  maxIterations: number;
  sandbox: boolean;
  tools: string[]; // tool names
  mcpServers: string[];
  permissions: {
    defaultMode: PermissionMode;
    allowedTools: string[];
    deniedTools: string[];
  };
}

export interface AgentRunResult {
  text: string;
  messages: Message[];
  iterations: number;
  truncated: boolean;
  toolCallsExecuted: number;
  sessionId?: string;
}

// ===== 任务 =====

export interface Task {
  instruction: string;
  sessionId?: string;
  mode?: PermissionMode;
  workingDir?: string;
}

// ===== 工作目录感知 =====

export interface ProjectProfile {
  type: string;
  pkgManager: string;
  testFramework: string;
  entryFile: string;
  topDirs: string[];
  keyFiles: string[];
}

// ===== 监控日志 =====

export interface TurnLog {
  id: string;
  sessionId: string;
  agentId: string;
  seq: number;
  userInput: string;
  startedAt: number;
  finishedAt: number;
  iterations: number;
  toolCallsTotal: number;
  toolCallsSuccess: number;
  toolCallsFailed: number;
  tokensPrompt: number;
  tokensCompletion: number;
  finishReason: string;
  error?: string;
}

export interface ToolCallLog {
  id: string;
  turnId: string;
  toolName: string;
  iteration: number;
  args: string;
  startedAt: number;
  durationMs: number;
  success: boolean;
  resultPreview: string;
  error?: string;
}

// ===== 上下文分层统计 (M5) =====

export interface ContextBreakdown {
  systemPromptBase: number;
  projectMemory: number;
  userProfile: number;
  episodicMemory: number;
  injectedSkills: number;
  conversationHistory: number;
  currentTurn: number;
  total: number;
  windowSize: number;
  skillsMatched: string[];
  skillsTotal: number;
}

export interface McpToolUsage {
  serverName: string;
  serverStatus: string;
  toolCount: number;
  toolNames: string[];
  callsTotal: number;
  callsFailed: number;
}

// ===== 记忆 =====

export interface SessionRecord {
  id: string;
  agentId: string;
  createdAt: number;
  updatedAt: number;
  summary?: string;
}

export interface EpisodicEntry {
  id: string;
  sessionId: string;
  timestamp: number;
  content: string;
  summary?: string;
  weight: number; // 时间衰减加权
  decayFactor?: number; // 查询时动态计算的衰减系数
}

// ===== Hooks =====

export type HookEvent = "onMessage" | "onToolCallPre" | "onToolCallPost" | "onTaskComplete" | "onError";

export interface HookContext {
  event: HookEvent;
  agentId: string;
  sessionId: string;
  data: Record<string, unknown>;
}

export interface HookResult {
  proceed: boolean; // false = 拦截
  modifiedData?: Record<string, unknown>;
  message?: string;
}

export type HookHandler = (ctx: HookContext) => Promise<HookResult | void>;

// ===== MCP (Model Context Protocol) =====

export type McpTransport = "stdio" | "http";

export interface McpServerConfig {
  name: string;
  transport: McpTransport;
  enabled?: boolean;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerStatus {
  name: string;
  transport: McpTransport;
  connected: boolean;
  toolCount: number;
  error?: string;
}

// ===== Skills 系统 =====

export interface SkillDef {
  name: string;
  version: string;
  triggers: string[];
  expert: string;
  toolsRequired: string[];
  modelPreference?: string;
  body: string;
  filePath: string;
}

// ===== Team Coordinator =====

export interface ExecutionStep {
  id: string;
  description: string;
  expertId: string;
  dependsOn: string[];
  critical: boolean;
}

export interface ExecutionPlan {
  steps: ExecutionStep[];
  goal: string;
  estimatedSteps: number;
}

export interface PlanTemplate {
  id: string;
  name: string;
  matchPattern: RegExp[];
  steps: ExecutionStep[];
}

export interface CoordinatorResult {
  text: string;
  plan: ExecutionPlan;
  stepResults: Map<string, string>;
  failedSteps: string[];
  source: "template" | "llm";
}
