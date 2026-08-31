/**
 * AiWorker 核心类型定义
 * 基于 OpenAI 标准 message 格式，保证多模型切换零摩擦
 */

// ===== 消息与对话 =====

export type Role = "system" | "user" | "assistant" | "tool";

/** 多模态消息内容块（Sprint 36 语音视频：文本 + 图片） */
export type MessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface Message {
  role: Role;
  /** 纯文本或多模态内容块数组（图片消息走数组；OpenAI 兼容格式） */
  content: string | MessageContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** 提取消息纯文本（多模态数组取全部 text 块拼接；供上下文组装/token 估算/审计等） */
export function messageText(msg: { content: string | MessageContentPart[] }): string {
  return typeof msg.content === "string"
    ? msg.content
    : msg.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
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
  /** 数据目录（spill 落盘用：<dataDir>/spills/，缺省则不落盘） */
  dataDir?: string;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
  enabled: boolean;
  /** 运行时可用性检查，返回 false 则该工具在本次调用中不可见 */
  availabilityCheck?: (ctx: ToolContext) => boolean | Promise<boolean>;
  /** 注册来源插件名（插件注册的工具带此标记，供 /plugins 追踪） */
  plugin?: string;
}

// ===== 模型接口 =====

export interface ModelCompleteOptions {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** 思考模式覆盖（缺省用 profile；生成器传 false 省 token 防空输出） */
  thinking?: boolean;
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
  /** 绑定技能（按名称；运行时注入 systemPrompt，见 BaseAgent.applyDeclaredSkills） */
  skills?: string[];
  /** 绑定插件（按插件名；保存时展开其工具进 tools 白名单） */
  plugins?: string[];
  /** 严格工具模式：关闭 mcp_/插件工具的全局豁免，仅白名单可见（默认 false 宽松） */
  strictTools?: boolean;
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
  /** 多模态：随本轮提问附带的图片（data URL 或 https URL；仅当轮上下文，不持久化） */
  images?: string[];
  /** 技能模式：/技能名 显式激活的技能（正文注入系统提示而非用户消息，避免污染历史与触发词二次注入） */
  explicitSkill?: { name: string; body: string };
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

// ===== 插件系统（Sprint 27，报告 #1 轻量插件契约） =====

export interface PluginInfo {
  /** 插件名（config/plugins/<name>/ 目录名） */
  name: string;
  version?: string;
  description?: string;
  /** 实际加载的入口文件路径 */
  entry: string;
  status: "loaded" | "error";
  error?: string;
  /** 注册的工具（scope 注册带 "scope:name" 前缀） */
  registeredTools: string[];
  registeredHooks: number;
  /** 注册期警告（如全局同名工具覆盖），/plugins 以 ⚠ 展示 */
  warnings?: string[];
}

export interface PluginRegisterToolOptions {
  /** 注册到指定作用域（缺省全局；同名遮蔽全局，见 ToolScopeView） */
  scope?: string;
  enabled?: boolean;
  availabilityCheck?: (ctx: ToolContext) => boolean | Promise<boolean>;
}

/** 插件运行上下文 — 契约即"默认导出 setup(ctx)"，零框架依赖 */
export interface PluginContext {
  name: string;
  dataDir: string;
  /** config/plugins/<name>/config.json（存在则解析） */
  config: Record<string, unknown>;
  registerTool(
    name: string,
    definition: ToolDefinition,
    handler: ToolHandler,
    options?: PluginRegisterToolOptions,
  ): void;
  /** 委托 hookManager.on（返回 hook id，供插件注销） */
  registerHook(event: HookEvent, handler: HookHandler, options?: { id?: string; priority?: number }): string;
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

// ===== 进化引擎（Sprint 39：观察 + 提议） =====

/** 观察窗口内的单工具聚合统计 */
export interface EvolutionToolStat {
  name: string;
  calls: number;
  failed: number;
  successRate: number;
  avgDurationMs: number;
  topErrors: { err: string; count: number }[];
}

/** 观察结果（全部从 session_events / audit 派生，不新增存储） */
export interface EvolutionObservation {
  windowStart: number;
  windowEnd: number;
  toolStats: EvolutionToolStat[];
  completion: { sessions: number; ok: number; rate: number; avgTurns: number };
  repeatedTasks: { pattern: string; count: number; examples: string[] }[];
  userInterventions: number;
  generated: { apps: number; docs: number; updates: number };
}

/** 提案动作（按类型结构化；Sprint 40 扩展 tool-fix/prompt-fix 携带改进内容） */
export type EvolutionAction =
  | { kind: "new-skill"; expert: string; body: string }
  | { kind: "new-tool"; description: string; type: "tool" }
  | { kind: "new-app"; description: string; type: "app" }
  | { kind: "config-change"; field: "temperature" | "maxTokens"; value: number }
  | { kind: "tool-fix"; toolName: string; suggestion: string; newDescription: string }
  | { kind: "prompt-fix"; agentId: string; suggestion: string; newPrompt: string };

export type EvolutionProposalType = EvolutionAction["kind"];

/** 进化提案（meta-agent 产出；两段式确认：pending→confirmed（采纳，仅确认内容）→applied（确认写入生效）→rolled_back（回滚终态）） */
export interface EvolutionProposal {
  id: string;
  type: EvolutionProposalType;
  title: string;
  reason: string;
  action: EvolutionAction;
  risk: "low" | "medium" | "high";
  status: "pending" | "confirmed" | "applied" | "rejected" | "rolled_back";
  createdAt: number;
  meta?: { tokens?: number };
}

/** 采纳确认后的写入预览（= 提案 action，前端/CLI 展示供用户审查） */
export type EvolutionPreview = EvolutionAction;

// ===== AI OS 应用模型（Sprint 34） =====

/** 应用类型：Sprint 34 支持 tool/skill/agent/service；app（webapp）Sprint 35 */
export type AppType = "tool" | "skill" | "agent" | "service" | "app";

/** 应用权限（terminal 被禁用，manifest schema 拒绝） */
export type AppPermission = "network" | "notify" | "llm" | `fs:${string}`;

/** 能力桥能力（子进程/iframe 可请求的系统能力） */
export type AppCapability = "storage" | "notify" | "llm" | "fs" | "http";

export interface AppToolDecl {
  name: string;
  description: string;
  parameters: ToolParameter;
}

export interface AppManifest {
  id: string;
  type: AppType;
  name: string;
  version: string;
  description: string;
  /** 相对沙箱目录的入口文件（webapp 为 index.html） */
  entry: string;
  /** 静态声明权限（运行时未声明能力走 ask 通道申请） */
  permissions?: AppPermission[];
  /** tool 类型：注册的工具声明 */
  tools?: AppToolDecl[];
  lifecycle?: { onStart?: string; onStop?: string; onDestroy?: string };
  /** 生成来源会话（审计回溯） */
  originSessionId?: string;
  /** service 类型：OS 启动自动拉起 */
  autostart?: boolean;
  /** app（webapp）类型：窗口形态 */
  ui?: { surface?: AppSurface };
}

export type AppStatus = "installed" | "starting" | "running" | "stopping" | "stopped" | "failed" | "destroyed";

export interface AppInfo {
  id: string;
  type: AppType;
  name: string;
  version: string;
  description: string;
  entry: string;
  permissions: string[];
  tools: string[];
  status: AppStatus;
  autostart: boolean;
  originSessionId?: string;
  lastError?: string;
  crashCount?: number;
  /** 来源插件（config/plugins/ 兼容视图） */
  plugin?: boolean;
  /** app（webapp）类型：窗口形态（panel/float/widget） */
  ui?: { surface?: AppSurface };
}

// ===== 进程模型（Sprint 34） =====

export type AgentProcessStatus = "running" | "done" | "failed" | "killed";
export type AppProcessStatus = "starting" | "running" | "stopping" | "stopped" | "failed";

export type OsProcess =
  | {
      kind: "agent";
      pid: string;
      agentId: string;
      sessionId: string;
      status: AgentProcessStatus;
      priority: "front" | "bg";
      startedAt: number;
      endedAt?: number;
    }
  | {
      kind: "app";
      pid: string;
      appId: string;
      status: AppProcessStatus;
      startedAt: number;
      endedAt?: number;
    }
  | {
      kind: "job";
      pid: string;
      jobId: string;
      status: "queued" | "running" | "done" | "failed";
      startedAt?: number;
      endedAt?: number;
    };

// ===== AppFactory 即时生成（Sprint 35） =====

/** 生成产出的一个文件 */
export interface GenFile {
  path: string;
  content: string;
}

/** 应用窗口形态 */
export type AppSurface = "panel" | "float" | "widget";

/** 生成规格（用户描述 + 模板 id/形态；type 缺省 "app" 表示自动识别） */
export interface AppSpec {
  description: string;
  type: string;
  surface?: AppSurface;
  sessionId?: string;
}

/** 生成模板（契约：结构/行数上限/权限白名单/提示词） */
export interface AppTemplate {
  id: string;
  type: AppType;
  name: string;
  description: string;
  /** 文件职责约定（提示词注入） */
  structure: string;
  /** 权限白名单（生成期安全：LLM 只能从中选择，不能新增） */
  allowedPermissions: string[];
  /** 生成步骤说明（webapp 分块：逻辑→样式） */
  steps: { id: string; label: string }[];
}

/** 生成器抽象（Sprint 35 v2：生成走 agent-loop + fs_write 工具，无独立生成器类） */

export interface GenerateResult {
  ok: boolean;
  app?: AppInfo;
  error?: string;
  files?: GenFile[];
  /** 文档型产出路径（data/docs/...） */
  docPath?: string;
}
