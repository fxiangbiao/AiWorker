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
  /** 工作目录（读写统一基准；--dir 指定，默认 ./ai_default_project） */
  workingDir: string;
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
  /** 稳定错误码（llm 适配器层分类，见 src/core/llm/llm-error.ts） */
  errorCode?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface StreamCallbacks {
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onThinkingStart?: () => void;
  onIterationStart?: (iteration: number) => void;
  onToolCall?: (name: string, args: string, id: string) => void;
  onToolResult?: (name: string, success: boolean, summary: string, id?: string) => void;
  onStepStart?: (stepId: string, expertId: string, desc: string) => void;
  onStepEnd?: (stepId: string, success: boolean) => void;
  onFileDiff?: (filePath: string, added: number, removed: number, diffText?: string) => void;
}

// ===== 智能体 =====

export type PermissionMode = "ask" | "plan" | "auto";

export interface PermissionConfig {
  defaultMode: PermissionMode;
  modes: Record<
    PermissionMode,
    {
      description: string;
      allow_tool_calls: boolean;
      require_confirmation?: boolean;
      high_risk_confirm?: boolean;
      readOnly?: boolean;
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
  /** 本轮最后一次主请求的 usage（assistant/message 事件携带，避免被压缩请求覆盖） */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
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

export type HookEvent =
  | "onMessage"
  | "onToolCallPre"
  | "onToolCallPost"
  | "onTaskComplete"
  | "onError"
  | "onTelemetryRecord";

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
  state?: "disconnected" | "connecting" | "connected" | "reconnecting" | "dead";
  error?: string;
  tools?: { name: string; description: string }[];
}

// ===== Skills 系统 =====

export interface SkillDef {
  name: string;
  version: string;
  description: string;
  triggers: string[];
  expert: string;
  toolsRequired: string[];
  modelPreference?: string;
  body: string;
  raw?: string;
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

// ===== 会话事件溯源（Sprint 24） =====

/**
 * 事件词汇 — 可声明合并扩展（对齐 DSH SessionEventMap）：
 * 会话是仅追加事件日志（session_events）的唯一真源，消息/轮次/工具/记忆均为投影。
 */
export interface SessionEventMap {
  "session/created": { agentId: string };
  "turn/start": { turn: number };
  "turn/end": { turn: number; reason: "stop" | "error" | "aborted" | "length" };
  "step/start": { step: number };
  "step/end": { step: number };
  "user/message": Message;
  "assistant/message": {
    message: Message;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  };
  "tool/call": { callId: string; name: string; arguments: string };
  "tool/result": { callId: string; success: boolean; content: string; error?: string; durationMs?: number };
  "memory/update": { kind: "episodic" | "semantic"; summary?: string };
  "title/set": { title: string };
}

export type SessionEventType = keyof SessionEventMap;

/** 一条不可变会话事件（seq 每会话内连续递增） */
export interface SessionEvent {
  seq: number;
  sessionId: string;
  type: SessionEventType;
  data: Record<string, unknown>;
  createdAt: number;
  /** 可选来源标记（hook / agent / server），便于溯源 */
  source?: string;
}

// ===== 轨迹观测（Sprint 25） =====

export interface TraceItem {
  seq: number;
  type: "turn" | "step" | "user" | "assistant" | "tool" | "memory" | "title";
  label: string;
  detail?: string;
  /** 完整内容（未截断），供轨迹项点击展开查看详情 */
  full?: string;
  at: number;
  durationMs?: number;
  status?: "ok" | "fail" | "running";
  tokens?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface SessionStats {
  sessionId: string;
  turnCount: number;
  stepCount: number;
  toolCallsTotal: number;
  toolCallsFailed: number;
  toolCallsSuccessRate: number;
  tokensPrompt: number;
  tokensCompletion: number;
  tokensTotal: number;
  wallMs: number;
  finishReason: string;
  errorCount: number;
}

export interface SessionTelemetryRecord {
  channel: "ledger" | "ops";
  time: number;
  severity: "info" | "warn" | "error";
  attributes: Record<string, string | number>;
  body: unknown;
}
