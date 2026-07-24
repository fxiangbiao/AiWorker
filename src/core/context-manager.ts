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
import type { Message } from "../types.js";
import type { SessionStore as SessionStoreClass } from "../memory/session-store.js";
import { ContextCompressor } from "../memory/compressor.js";
import { skillRegistry } from "./skill-registry.js";

const MEMORY_MAX_CHARS = 2200; // 有界：~2200 字符
const USER_MAX_CHARS = 1375; // 有界：~1375 字符

export class ContextManager {
  private sessionStore: SessionStoreClass;
  private compressor: ContextCompressor;
  private memoryDir: string;
  private frozenSnapshot?: {
    memory: string;
    user: string;
  };

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
      writeFileSync(memoryPath, "# Agent 记忆\n\n_(有界管理，自动更新)_\n");
    }
    if (!existsSync(userPath)) {
      writeFileSync(userPath, "# 用户画像\n\n_(有界管理，自动更新)_\n");
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
    return content.slice(0, maxChars); // 有界截断
  }

  /**
   * 组装上下文 — 按注入顺序构建消息列表
   * 参考 OpenClaw 四层组装：
   * 系统提示词 → 项目记忆 → 用户画像 → 技能列表 → 历史摘要 → 当前任务 → 用户消息
   */
  async assembleContext(
    systemPrompt: string,
    sessionId: string,
    userMessage: string,
    agentId?: string
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

  /** 更新语义记忆 (有界写入) */
  updateMemory(content: string): void {
    const path = resolve(this.memoryDir, "MEMORY.md");
    const bounded = content.slice(0, MEMORY_MAX_CHARS);
    writeFileSync(path, bounded, "utf-8");
  }

  updateUserProfile(content: string): void {
    const path = resolve(this.memoryDir, "USER.md");
    const bounded = content.slice(0, USER_MAX_CHARS);
    writeFileSync(path, bounded, "utf-8");
  }

  /** 总结会话并写入 MEMORY.md（有界写入） */
  async summarizeSession(messages: Message[], taskDescription: string): Promise<string> {
    const { result } = await this.compressor.compress(messages);
    if (!result.summary) return "";

    const memoryContent = `# Agent 记忆\n\n` +
      `> 上次任务: ${taskDescription.slice(0, 150)}\n\n` +
      `## 对话摘要\n${result.summary}`;

    const bounded = memoryContent.slice(0, MEMORY_MAX_CHARS);
    const path = resolve(this.memoryDir, "MEMORY.md");
    writeFileSync(path, bounded, "utf-8");
    return bounded;
  }
}
