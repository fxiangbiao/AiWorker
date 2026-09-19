/**
 * 上下文管理器 — 三层记忆组装
 * 设计依据：调研报告 3.2 节
 *
 * Layer 1: 工作记忆 (当前会话上下文)
 * Layer 2: 情景记忆 (FTS5 跨会话检索)
 * Layer 3: 语义记忆 (MEMORY.md + USER.md 有界)
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Message, ProjectProfile, ContextBreakdown } from "../types.js";
import type { SessionStore as SessionStoreClass } from "../memory/session-store.js";
import { ContextCompressor } from "../memory/compressor.js";
import { estimateText } from "./token-estimate.js";
import { skillRegistry } from "./skill-registry.js";

const MEMORY_MAX_CHARS = 2200; // 有界：~2200 字符
const USER_MAX_CHARS = 1375; // 有界：~1375 字符
const PROJECT_MAX_CHARS = Math.floor(MEMORY_MAX_CHARS * 0.4);
const HISTORY_MAX_CHARS = Math.floor(MEMORY_MAX_CHARS * 0.6);
const TOOL_MSG_MAX_CHARS = 20000; // 单条 tool 消息上限（超长截断；事件日志保留完整，replay-safe）

/** 上下文分层展示默认窗口（调用方未传 windowSize 时用，与历史兜底一致） */
const DEFAULT_WINDOW = 32768;

/**
 * 工具结果剪枝（对齐 DSH dsh-compaction-tool-result-pruner）：
 * 组装上下文时截断超长 tool 消息，避免撑爆窗口；完整内容仍在 session_events 中
 */
function pruneOversizedToolMessages(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (m.role === "tool" && m.content.length > TOOL_MSG_MAX_CHARS) {
      return {
        ...m,
        content:
          m.content.slice(0, TOOL_MSG_MAX_CHARS) +
          `\n…[已截断，完整内容见事件日志/落盘文件（原文 ${m.content.length} 字符）]`,
      };
    }
    return m;
  });
}

function safeTruncate(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const slice = content.slice(0, maxChars);
  // 回溯到最近的段落边界（双换行或标题行），避免截断在代码块或句子中间
  const paraBreak = slice.lastIndexOf("\n\n");
  const headingBreak = slice.lastIndexOf("\n##");
  const cutoff = Math.max(paraBreak, headingBreak);
  if (cutoff > maxChars * 0.5) {
    return slice.slice(0, cutoff);
  }
  // 退而求其次：最后一个换行处
  const lineBreak = slice.lastIndexOf("\n");
  if (lineBreak > maxChars * 0.6) {
    return slice.slice(0, lineBreak);
  }
  return slice;
}

const SECTION_PROJECT = "## 项目信息";
const SECTION_HISTORY = "## 会话历史";

export class ContextManager {
  private sessionStore: SessionStoreClass;
  private compressor: ContextCompressor;
  private memoryDir: string;
  private frozenSnapshot?: {
    memory: string;
    user: string;
  };
  private _writeLock: Promise<void> = Promise.resolve();
  private projectProfile: ProjectProfile | null = null;

  private async acquireLock(): Promise<() => void> {
    const prev = this._writeLock;
    let release: () => void;
    this._writeLock = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    return release!;
  }

  constructor(sessionStore: SessionStoreClass, dataDir: string, compressor?: ContextCompressor) {
    this.sessionStore = sessionStore;
    this.memoryDir = resolve(dataDir, "memory");
    this.compressor = compressor ?? new ContextCompressor();
    this.ensureMemoryFiles();
  }

  private ensureMemoryFiles(): void {
    mkdirSync(this.memoryDir, { recursive: true });
    const memoryPath = resolve(this.memoryDir, "MEMORY.md");
    const userPath = resolve(this.memoryDir, "USER.md");
    if (!existsSync(memoryPath)) {
      writeFileSync(
        memoryPath,
        `# Agent 记忆\n\n${SECTION_PROJECT}\n\n_(在此记录项目信息)_\n\n${SECTION_HISTORY}\n\n_(自动滚动，最近优先)_\n`,
      );
    }
    if (!existsSync(userPath)) {
      writeFileSync(userPath, "# 用户画像\n\n_(自动更新，有界管理)_\n");
    }
  }

  /**
   * 冻结快照 — 会话开始时捕获
   * 保证前缀缓存有效（Anthropic 等整个会话有效），大幅降本
   */
  freezeSnapshot(): void {
    this.frozenSnapshot = {
      memory: this.readBounded("MEMORY.md", MEMORY_MAX_CHARS),
      user: this.readBounded("USER.md", USER_MAX_CHARS),
    };
  }

  private readBounded(filename: string, maxChars: number): string {
    const path = resolve(this.memoryDir, filename);
    if (!existsSync(path)) return "";
    const content = readFileSync(path, "utf-8");
    return safeTruncate(content, maxChars);
  }

  /** 注入工作目录画像 — 启动时由 ProjectProfiler 设置 */
  setProjectProfile(profile: ProjectProfile | null): void {
    this.projectProfile = profile;
  }

  /** 估算字符串 token 数（共享启发式：CJK≈1/字、ASCII≈1/4字符；展示用，真实以 provider usage 为准） */
  private estimateTokens(text: string): number {
    return estimateText(text);
  }

  /** 事件回放 → 估算文本（含 tool 消息 content 与 assistant tool_calls 参数），对齐 assembleContext 组装；
   *  tool content 按 TOOL_MSG_MAX_CHARS 同规则截断后再估算（review：展示贴近真实请求，避免长 tool 输出虚高） */
  private replayText(sessionId: string): string {
    const messages = pruneOversizedToolMessages(this.sessionStore.replayEvents(sessionId));
    const parts: string[] = [];
    for (const m of messages) {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      parts.push(content);
      if (m.tool_calls) parts.push(JSON.stringify(m.tool_calls));
    }
    return parts.join("\n");
  }

  /** 历史 token 估算缓存（R5）：键 = 事件数，会话无新事件则复用，避免 printStatus 高频全量回放 */
  private historyCache = new Map<string, { eventCount: number; tokens: number }>();
  /** 缓存上限（防会话删除后无清理导致的无限增长；超限整体重置，代价可接受） */
  private readonly HISTORY_CACHE_MAX = 500;

  private historyTokens(sessionId: string): number {
    if (this.historyCache.size >= this.HISTORY_CACHE_MAX) {
      this.historyCache.clear();
    }
    const count = this.sessionStore.getEventCount(sessionId);
    const hit = this.historyCache.get(sessionId);
    if (hit && hit.eventCount === count) return hit.tokens;
    const tokens = this.estimateTokens(this.replayText(sessionId));
    this.historyCache.set(sessionId, { eventCount: count, tokens });
    return tokens;
  }

  /** 上下文分层 token 占比统计（windowSize 由调用方传模型真实窗口；缺省用默认展示窗口） */
  getContextBreakdown(
    systemPrompt: string,
    sessionId: string,
    userMessage: string,
    agentId?: string,
    windowSize: number = DEFAULT_WINDOW,
  ): ContextBreakdown {
    const snapshot = this.frozenSnapshot ?? {
      memory: this.readBounded("MEMORY.md", MEMORY_MAX_CHARS),
      user: this.readBounded("USER.md", USER_MAX_CHARS),
    };

    const base = this.estimateTokens(systemPrompt);
    const projMem = this.estimateTokens(snapshot.memory);
    const userProf = this.estimateTokens(snapshot.user);

    // Episodic memory
    const episodicResults = this.sessionStore.searchEpisodic(userMessage, 3);
    const epiText = episodicResults.map((e) => e.summary ?? e.content).join("\n");
    const epi = this.estimateTokens(epiText);

    // Skills
    let skillsPrompt = "";
    const matchedSkills: string[] = [];
    if (agentId && skillRegistry.count > 0) {
      skillsPrompt = skillRegistry.getInjectedPrompt(agentId, userMessage);
      matchedSkills.push(...skillRegistry.match(userMessage, agentId).map((s) => s.name));
    }
    const skills = this.estimateTokens(skillsPrompt);

    // Conversation history（事件回放：含 tool 消息与 tool_calls 参数，缓存按事件数失效）
    const hist = this.historyTokens(sessionId);

    const current = this.estimateTokens(userMessage);
    const total = base + projMem + userProf + epi + skills + hist + current;

    // Project profile
    let projProfText = "";
    if (this.projectProfile) {
      projProfText = [
        `- 项目类型: ${this.projectProfile.type}`,
        `- 包管理器: ${this.projectProfile.pkgManager}`,
        `- 顶层目录: ${this.projectProfile.topDirs.join(", ")}`,
      ].join("\n");
    }
    const projProf = this.estimateTokens(projProfText);

    return {
      systemPromptBase: base + projProf,
      projectMemory: projMem,
      userProfile: userProf,
      episodicMemory: epi,
      injectedSkills: skills,
      conversationHistory: hist,
      currentTurn: current,
      total,
      windowSize,
      remaining: windowSize - total,
      skillsMatched: matchedSkills,
      skillsTotal: skillRegistry.count,
    };
  }

  async assembleContext(
    systemPrompt: string,
    sessionId: string,
    userMessage: string,
    agentId?: string,
    /** 多模态图片（data URL/https；Sprint 36）：随当前用户消息组装 content 数组 */
    images?: string[],
    /** 技能模式：/技能名 显式激活的技能（注入系统提示，仅当轮上下文，不落历史） */
    explicitSkill?: { name: string; body: string },
    /** 历史下界：只回放事件 seq 小于该值的历史（当前用户消息已落库时传入其事件 seq，
     *  否则同一条 user 会被"事件回放 + 参数"注入两次；历史存的是纯文本、当轮参数可能是多模态数组，
     *  故按边界剔除而不是按内容去重） */
    historyBeforeEventSeq?: number,
  ): Promise<Message[]> {
    const snapshot = this.frozenSnapshot ?? {
      memory: this.readBounded("MEMORY.md", MEMORY_MAX_CHARS),
      user: this.readBounded("USER.md", USER_MAX_CHARS),
    };

    const messages: Message[] = [];

    // 1. 系统提示词 (Agent 人设)
    let fullSystemPrompt = systemPrompt;

    // 2. 项目记忆 (MEMORY.md 快照)
    if (snapshot.memory) {
      fullSystemPrompt += `\n\n--- 项目记忆 ---\n${snapshot.memory}`;
    }

    // 2.5. 工作目录感知 (ProjectProfile)
    if (this.projectProfile) {
      const p = this.projectProfile;
      const parts: string[] = [`- 项目类型: ${p.type}`];
      if (p.pkgManager) parts.push(`- 包管理器: ${p.pkgManager}`);
      if (p.testFramework) parts.push(`- 测试框架: ${p.testFramework}`);
      if (p.entryFile) parts.push(`- 入口文件: ${p.entryFile}`);
      if (p.topDirs.length > 0) parts.push(`- 顶层目录: ${p.topDirs.join(", ")}`);
      if (p.keyFiles.length > 0) parts.push(`- 关键文件: ${p.keyFiles.join(", ")}`);
      fullSystemPrompt += `\n\n--- 工作目录 ---\n${parts.join("\n")}`;
    }

    // 3. 用户画像 (USER.md 快照)
    if (snapshot.user) {
      fullSystemPrompt += `\n\n--- 用户画像 ---\n${snapshot.user}`;
    }

    // 4. 历史摘要 (FTS5 检索相关跨会话记忆)
    const episodicResults = this.sessionStore.searchEpisodic(userMessage, 3);
    if (episodicResults.length > 0) {
      const episodicText = episodicResults
        .map((e) => `[${new Date(e.timestamp).toLocaleDateString()}] ${e.summary ?? e.content}`)
        .join("\n");
      fullSystemPrompt += `\n\n--- 相关历史记忆 ---\n${episodicText}`;
    }

    // 5. 技能列表 (SKILL.md 匹配)
    if (agentId && skillRegistry.count > 0) {
      const skillsPrompt = skillRegistry.getInjectedPrompt(agentId, userMessage);
      if (skillsPrompt) {
        fullSystemPrompt += skillsPrompt;
      }
    }

    // 5.5. 显式激活技能（/技能名；注入系统提示而非用户消息——避免污染会话历史与触发词二次注入）
    if (explicitSkill) {
      fullSystemPrompt +=
        `\n\n-- 用户显式激活技能：${explicitSkill.name} --\n请严格按以下技能方法执行当前任务：\n${explicitSkill.body}\n-- 技能结束 --`;
    }

    messages.push({ role: "system", content: fullSystemPrompt });

    // 5. 当前会话历史（事件回放：含 tool_calls 与对应 tool 结果，保证 LLM 消息序列完整；
    //    不用 getMessages——投影表不含 tool 消息，assistant(tool_calls) 无 tool 响应会被 API 拒绝）
    const history = this.sessionStore.replayEvents(sessionId);
    const bounded =
      historyBeforeEventSeq === undefined
        ? history
        : history.filter((m) => (m.seq ?? 0) < historyBeforeEventSeq);
    messages.push(...bounded);

    // 6. 当前用户消息（多模态：带图片时组装 content 数组）
    const userContent: Message["content"] =
      images && images.length > 0
        ? [
            { type: "text", text: userMessage },
            ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
          ]
        : userMessage;
    messages.push({ role: "user", content: userContent });

    return pruneOversizedToolMessages(messages);
  }

  /**
   * 检查并执行压缩
   * @param scope 会话归属（可选）：压缩摘要请求计入该会话账本；缺省不进账本
   * @param window 模型物理窗口（可选）：小于压缩成本预算时按物理窗口收紧触发阈值与保留目标（review：本地 16384 窗口模型溢出护栏）
   */
  async maybeCompress(
    messages: Message[],
    scope?: string,
    window?: number,
  ): Promise<{
    messages: Message[];
    compressed: boolean;
  }> {
    if (this.compressor.needsCompression(messages, window)) {
      const { messages: compressed, result } = await this.compressor.compress(messages, scope, window);
      if (result.compressed) {
        return { messages: compressed, compressed: true };
      }
    }
    return { messages, compressed: false };
  }

  /** 写入项目信息段（不影响会话历史） */
  async updateMemory(content: string): Promise<void> {
    await this.writeProjectSection(content);
  }

  /** 写入 USER.md */
  updateUserProfile(content: string): void {
    const path = resolve(this.memoryDir, "USER.md");
    const bounded = safeTruncate(content, USER_MAX_CHARS);
    writeFileSync(path, bounded, "utf-8");
  }

  /** 总结会话并更新会话历史段（Sprint 44 方案 A：摘要请求不带 scope，仅进进程全局，不扰会话/轮次差分） */
  async summarizeSession(messages: Message[], taskDescription: string, sessionId: string): Promise<string> {
    const { result } = await this.compressor.compress(messages);
    if (!result.summary) return "";

    const today = new Date().toISOString().slice(0, 10);
    const entry = `- [${today}] ${taskDescription.slice(0, 120)}`;

    await this.appendHistoryEntry(entry);

    // 存入 FTS5 跨会话检索
    this.sessionStore.saveEpisodic(sessionId, taskDescription, result.summary, 1.0);

    // 自动更新用户画像
    const profile = this.extractUserProfile(messages);
    if (profile) this.mergeUserProfile(profile);

    return result.summary;
  }

  // ── 双段 MEMORY.md 管理 ──

  private readMemoryFile(): string {
    const path = resolve(this.memoryDir, "MEMORY.md");
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8");
  }

  private parseSections(): { projectInfo: string; sessionHistory: string } {
    const content = this.readMemoryFile();
    const projectIdx = content.indexOf(SECTION_PROJECT);
    const historyIdx = content.indexOf(SECTION_HISTORY);

    let projectInfo: string;
    let sessionHistory: string;

    if (projectIdx !== -1 && historyIdx !== -1) {
      projectInfo = content.slice(projectIdx + SECTION_PROJECT.length, historyIdx).trim();
      sessionHistory = content.slice(historyIdx + SECTION_HISTORY.length).trim();
    } else {
      projectInfo = content;
      sessionHistory = "";
    }

    return { projectInfo, sessionHistory };
  }

  private writeSections(projectInfo: string, sessionHistory: string): void {
    const path = resolve(this.memoryDir, "MEMORY.md");
    const boundedProject = safeTruncate(projectInfo, PROJECT_MAX_CHARS);
    const boundedHistory = safeTruncate(sessionHistory, HISTORY_MAX_CHARS);

    const lines = [
      "# Agent 记忆",
      "",
      SECTION_PROJECT,
      "",
      boundedProject || "_(待记录)_",
      "",
      SECTION_HISTORY,
      "",
      boundedHistory || "_(暂无历史)_",
    ];
    writeFileSync(path, lines.join("\n"), "utf-8");
  }

  private async writeProjectSection(content: string): Promise<void> {
    const release = await this.acquireLock();
    try {
      const { sessionHistory } = this.parseSections();
      this.writeSections(content, sessionHistory);
    } finally {
      release();
    }
  }

  private async appendHistoryEntry(entry: string): Promise<void> {
    const release = await this.acquireLock();
    try {
      const { projectInfo, sessionHistory } = this.parseSections();
      const lines = sessionHistory
        .split("\n")
        .filter((l) => l.trim())
        .slice(0, 20); // 保留最多 20 条
      lines.unshift(entry);
      this.writeSections(projectInfo, lines.join("\n"));
    } finally {
      release();
    }
  }

  // ── 用户画像提取 ──

  private extractUserProfile(messages: Message[]): string | null {
    const userMessages = messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join(" ");

    const patterns: { regex: RegExp; label: string }[] = [
      { regex: /习惯用|常用|一直用|一直在用/g, label: "常用工具" },
      { regex: /先写测试|TDD|测试驱动/g, label: "测试习惯" },
      { regex: /用中文|中文回复|用英文/g, label: "语言偏好" },
      { regex: /React|Vue|Angular|Svelte|Next|Nuxt/g, label: "前端框架" },
      { regex: /Python|TypeScript|Go|Rust|Java/g, label: "编程语言" },
    ];

    const tags: string[] = [];
    for (const { label, regex } of patterns) {
      const match = userMessages.match(regex);
      if (match) {
        const unique = [...new Set(match)].join(", ");
        tags.push(`- ${label}: ${unique}`);
      }
    }

    if (tags.length === 0) return null;

    const today = new Date().toISOString().slice(0, 10);
    return `# 用户画像\n> 上次更新: ${today}\n\n${tags.join("\n")}`;
  }

  private mergeUserProfile(newProfile: string): void {
    // 简单覆盖（有界截断），后续可改为智能合并
    this.updateUserProfile(newProfile);
  }
}
