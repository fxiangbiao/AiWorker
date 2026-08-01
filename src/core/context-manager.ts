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
import { skillRegistry } from "./skill-registry.js";

const MEMORY_MAX_CHARS = 2200; // 有界：~2200 字符
const USER_MAX_CHARS = 1375; // 有界：~1375 字符
const PROJECT_MAX_CHARS = Math.floor(MEMORY_MAX_CHARS * 0.4);
const HISTORY_MAX_CHARS = Math.floor(MEMORY_MAX_CHARS * 0.6);

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

  /** 估算字符串 token 数 (混合中英文: ~3.5字符/token) */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 3.5);
  }

  /** 上下文分层 token 占比统计 */
  getContextBreakdown(
    systemPrompt: string,
    sessionId: string,
    userMessage: string,
    agentId?: string,
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

    // Conversation history
    const history = this.sessionStore.getMessages(sessionId);
    const histText = history.map((m) => m.content).join("\n");
    const hist = this.estimateTokens(histText);

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
      windowSize: 8000, // default; could be model-specific
      skillsMatched: matchedSkills,
      skillsTotal: skillRegistry.count,
    };
  }

  async assembleContext(
    systemPrompt: string,
    sessionId: string,
    userMessage: string,
    agentId?: string,
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

    messages.push({ role: "system", content: fullSystemPrompt });

    // 5. 当前会话历史
    const history = this.sessionStore.getMessages(sessionId);
    messages.push(...history);

    // 6. 当前用户消息
    messages.push({ role: "user", content: userMessage });

    return messages;
  }

  /** 检查并执行压缩 */
  async maybeCompress(messages: Message[]): Promise<{
    messages: Message[];
    compressed: boolean;
  }> {
    if (this.compressor.needsCompression(messages)) {
      const { messages: compressed, result } = await this.compressor.compress(messages);
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

  /** 总结会话并更新会话历史段 */
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
