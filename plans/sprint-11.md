# Sprint 11：多轮对话 + Skill 自进化 + 目录智能感知

> **目标**：打通多轮对话（核心交互模式），启动 Phase 4 自进化引擎（Skill 自动沉淀），弥补工作目录感知盲区。
> **预计工时**：~10h（3 个模块）

---

## 一、现状诊断

| 维度 | 问题 | 影响 |
|------|------|------|
| 多轮对话 | 每次输入都创建新任务——`agent.runStream()` 返回后 `messages` 被丢弃（`base-agent.ts` 返回 `messages: []`），下一轮像第一次见面 | 每个问题都要重新描述上下文，不能追问、不能修正 |
| Skill 自进化 | `createEvaluateSkillCreation` hook 生成 `skills/pending/auto-*.md` 骨架文件但不验证、不评分、不注册 | Phase 4 核心目标 "Skill 自动沉淀成功率 > 50%" 零进展 |
| 目录感知 | Agent 对项目结构一无所知，只能逐步 `fs_read`/`fs_list` 探索 | 浪费 token 和迭代次数在探索项目布局上 |

---

## 二、设计原则

1. **会话连续性** — 多轮对话复用同一 session，messages 不销毁，LLM 有完整上下文
2. **Skill 质量优先** — 自动生成后必须经过验证和评分，低质量自动丢弃
3. **零额外探索成本** — 目录结构在启动时一次性扫描，注入 system prompt

---

## 三、任务拆解

### M1 — 多轮对话模式（P0）

**现状**：

- `index.ts` 交互循环每次调用 `agent.runStream(...)` → 返回 → `result.messages` 被丢弃
- `base-agent.ts` 每次 `runStream` 都创建新 session（`sessionStore.createSession(...)`）
- session 的 messages 虽然写入了 SQLite（`getMessages`），但在 system prompt 组装时只作为历史追加，下一轮用户输入到模型时模型看不到上轮的 assistant 回复和工具结果——因为 `index.ts` 不传 `task.sessionId`

**根本原因**：CLI 层不传递上一轮的 `sessionId`，Agent 每次必须创建新会话。

**方案**：

#### 1.1 会话保持 (`src/index.ts`)

```typescript
let currentSessionId: string | undefined;
```

- 第一轮输入：`sessionId` 为 `undefined` → Agent 创建新 session → 存储返回的 sessionId
- 后续轮次：传入 `task.sessionId = currentSessionId` → Agent 复用同一 session
- `/new` 命令：手动清空 `currentSessionId`，开启新会话

#### 1.2 Agent 复用 session (`src/agents/base-agent.ts`)

`runStream()` 已支持 `task.sessionId` 参数（line 122）：

```typescript
const sessionId = task.sessionId ?? this.sessionStore.createSession(this.config.id).id;
```

但返回 `messages: []`（line 176 的 bug）会丢掉上下文。改为返回**摘要**而非清空。

当前设计意图是"避免内存膨胀"（注释 line 109），但更合理的是返回少量标记信息（iterations, toolCalls），messages 仅在 session store 中持久化，下次从 SQLite 读取。

#### 1.3 上下文连续性验证

- 同一 session 内，`assembleContext()` 通过 `getMessages(sessionId)` 读取历史消息（line 122），这些消息被追加到新 user 消息之前
- 关键：**每次 `runStream` 只追加一条 user 消息**，不重建 `assembleContext` 中的 system prompt 部分

#### 1.4 命令 `/chat`/`/new`

| 命令 | 行为 |
|------|------|
| 默认输入 | 使用同一 session 继续对话 |
| `/new` | 清空 currentSessionId，下一轮创建新 session |
| `/history` | 显示当前 session 最近 5 轮对话摘要 |

**改动文件**：2 (`index.ts`, `base-agent.ts`)

---

### M2 — Skill 自动沉淀（P1，Phase 4 启动）

**现状**：

- `createEvaluateSkillCreation` hook（`src/hooks/handlers.ts`）在 `onTaskComplete` 触发
- 条件：iterations >= 3 && toolCallsExecuted >= 3
- 行为：生成 `skills/pending/auto-{expert}-{hash}.md` 文件
- 缺陷：生成即丢弃（无验证、无评分、无注册），pending 目录在 `.gitignore` 中

**方案**：

#### 2.1 完整流水线

```
任务完成 (iter>=3, toolCalls>=3)
  │
  ▼
① LLM 生成 SKILL.md → skills/pending/auto-*.md
  │
  ▼
② 验证 (Validate)
  ├─ YAML frontmatter 解析成功？
  ├─ name / triggers 非空？
  ├─ 工具依赖存在？
  └─ 任一失败 → 丢弃
  │
  ▼
③ 评分 (Score, LLM)
  ├─ 1-5 星评分
  ├─ 标准: 可复用性 / 清晰度 / 触发词准确性 / 工具依赖合理性
  └─ < 3 星 → 保留在 pending/ 供人工审核
  │
  ▼
④ 注册 (Register)
  ├─ >= 3 星 → 自动移动到 skills/{expert}/ 目录
  ├─ skillRegistry.reloadSkill(path) 热加载
  └─ 通知用户: "✓ 新技能沉淀: stock-screening (4★)"
```

#### 2.2 技术实现

**新增文件**: `src/core/skill-evolution.ts`

```typescript
class SkillEvolution {
  async validate(skillPath: string): Promise<ValidationResult>;
  async score(skillPath: string): Promise<number>;  // 1-5
  async register(skillPath: string, expertId: string): Promise<boolean>;
  async evolve(messages: Message[], expertId: string): Promise<SkillEvolutionResult>;
}
```

**修改 `skill-registry.ts`**：新增 `reloadSkill(path)` 方法——热加载单个 SKILL.md。

**修改 `hooks/handlers.ts`**：`evaluateSkillCreation` hook 调用 `SkillEvolution.evolve()` 替代现有骨架生成。

#### 2.3 触发策略优化

- 当前仅 `iter>=3 && toolCalls>=3` 触发，过于宽泛
- 新增条件：任务成功率 > 0（非截断非报错）&& 涉及了至少 2 种不同工具
- 冷却期：同一 expert 每小时最多触发 3 次沉淀尝试

**改动文件**：~4（新增 1，修改 3）

---

### M3 — 工作目录智能感知（P2）

**现状**：

- `createAutoLoadProjectMemory` hook 加载 `package.json` 等关键文件存入 episodic memory
- 但这些信息在 episodic memory 中，并非在当前任务上下文中——agent 必须搜索 episodic 才能用上
- Agent 不知道项目类型、目录结构，首次对话大量 token 浪费在 `fs_list` 探索上

**方案**：

#### 3.1 新增类型 (`src/types.ts`)

```typescript
interface ProjectProfile {
  type: string;           // "node" | "python" | "rust" | "unknown"
  pkgManager: string;     // "npm" | "yarn" | "pnpm" | "pip" | "cargo"
  testFramework: string;  // "vitest" | "jest" | "pytest" | ""
  entryFile: string;      // "src/index.ts"
  topDirs: string[];      // ["src", "config", "skills", "plans"]
  keyFiles: string[];     // ["package.json", "tsconfig.json"]
}
```

#### 3.2 启动时扫描 (`src/core/project-profiler.ts`，新建)

```
扫描工作目录:
  ├─ 检测项目类型 → 文件特征匹配
  │   package.json → Node/TypeScript
  │   pyproject.toml / requirements.txt → Python
  │   Cargo.toml → Rust
  │   go.mod → Go
  ├─ 检测包管理器, 测试框架 → 分析 devDependencies
  ├─ 提取顶层目录树 (depth=1), 关键文件列表
  └─ 生成 ProjectProfile
```

#### 3.3 注入 System Prompt　(`src/core/context-manager.ts`)

在 `assembleContext()` 中新增注入点（在项目记忆和用户画像之间）：

```typescript
// 6.x 项目结构感知
if (this.projectProfile) {
  fullSystemPrompt += `\n\n--- 工作目录 ---\n`;
  fullSystemPrompt += `- 项目类型: ${this.projectProfile.type}\n`;
  fullSystemPrompt += `- 包管理器: ${this.projectProfile.pkgManager}\n`;
  fullSystemPrompt += `- 测试: ${this.projectProfile.testFramework || "未配置"}\n`;
  fullSystemPrompt += `- 目录: ${this.projectProfile.topDirs.join(", ")}\n`;
  fullSystemPrompt += `- 关键文件: ${this.projectProfile.keyFiles.join(", ")}\n`;
}
```

#### 3.4 启动加载 (`src/index.ts`)

```typescript
const profiler = new ProjectProfiler(workingDir);
contextManager.setProjectProfile(profiler.scan());
```

**改动文件**：~3（新增 1，修改 2）

---

## 四、文件清单

| 任务 | 新建 | 修改 |
|------|------|------|
| M1 多轮对话 | — | `index.ts`, `base-agent.ts` |
| M2 Skill 自动沉淀 | `src/core/skill-evolution.ts` | `hooks/handlers.ts`, `core/skill-registry.ts`, `index.ts` |
| M3 目录智能感知 | `src/core/project-profiler.ts` | `context-manager.ts`, `index.ts`, `types.ts` |

**汇总**：2 新建文件，6 个文件修改

---

## 五、验证标准

| 任务 | 验证方式 |
|------|---------|
| M1 | 首轮输入 "列出项目文件" → 第二轮输入 "刚才列了多少个？" → Agent 能回答正确（证明上下文保留） |
| M1 | `/new` → 新对话从空白开始，不再引用上轮内容 |
| M2 | 执行复杂任务（3+ 工具调用）→ 完成时看到 "✓ 新技能沉淀: xxx (4★)" → `skills/{expert}/` 目录出现新 SKILL.md |
| M2 | 低质任务 → 无沉淀或沉淀在 `pending/` 目录 |
| M3 | 启动后在日志或 `/status` 中看到 "项目: Node/TypeScript, npm, vitest, 8 个顶层目录" |
| M3 | 首次对话中 agent 直接引用项目结构，无需调用 `fs_list` 探索 |
| 回归 | `npm run build` 通过，`npm test` 85 项全过 |
