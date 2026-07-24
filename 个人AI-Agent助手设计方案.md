# 个人 AI Agent 助手 — 可行设计方案

> 项目名称：**AiWorker**  
> 设计依据：《AI-Agent应用调研分析与搭建方案.md》九大产品调研结论  
> 设计目标：灵活组合业界成熟技术（多智能体 / 上下文管理 / Skills / MCP / Hooks），预置六大专家智能体  
> 设计时间：2026 年 7 月

---

## 目录

1. [设计理念与核心原则](#一设计理念与核心原则)
2. [系统总体架构](#二系统总体架构八层模型)
3. [核心技术模块实现](#三核心技术模块实现)
4. [六大预置专家智能体](#四六大预置专家智能体)
5. [多智能体协作机制](#五多智能体协作机制)
6. [安全与权限模型](#六安全与权限模型)
7. [技术选型与目录结构](#七技术选型与目录结构)
8. [实施路线图](#八实施路线图)

---

## 一、设计理念与核心原则

### 1.1 从调研中提取的五条铁律

| # | 铁律 | 来源 | 在本方案中的体现 |
|---|------|------|-----------------|
| 1 | **先做简单的事** | Claude Code：正则 > 向量库，Markdown > 数据库 | 记忆先用 MD + FTS5，向量检索作为增强层按需启用 |
| 2 | **协议优先于框架** | 调研共识：MCP/A2A 已成标准 | 所有工具走 MCP，不自造私有协议；框架自研轻量循环 |
| 3 | **技能 ≠ API** | 报告趋势六：Skill 给模型规划，组合逻辑运行时生成 | SKILL.md 描述技能，模型动态组合，而非硬编码调用链 |
| 4 | **越用越聪明是护城河** | HermesAgent：自进化闭环已工程落地 | 行为轨迹学习 + Skills 自动沉淀 + 有界记忆管理 |
| 5 | **安全是落地前提** | CodeBuddy 合规底座 + 监管趋势 | Day 1 内置三模式 + 沙箱 + Hooks 拦截 + 审计日志 |

### 1.2 核心设计原则

```
┌─────────────────────────────────────────────────────┐
│                AiWorker 设计原则                     │
├─────────────────────────────────────────────────────┤
│                                                     │
│  1. 模型无关    一套 OpenAI 兼容接口接所有模型         │
│                按任务复杂度/成本/隐私 三维路由          │
│                                                     │
│  2. 工具标准化  全部走 MCP 协议，热插拔注册            │
│                缺 Key 自动降级而非报错                  │
│                                                     │
│  3. 技能可组合  SKILL.md 描述，运行时动态组装           │
│                兼容 ClawHub / agentskills.io 生态      │
│                                                     │
│  4. 记忆有界    仿 HermesAgent 有界设计                │
│                强制优先级管理，保前缀缓存有效           │
│                                                     │
│  5. 渐进信任    Ask → Plan → Craft 三模式              │
│                默认保守，用户逐步授权                   │
│                                                     │
│  6. 可观测      每步操作有 diff/日志，可回滚            │
│                Hooks 在全生命周期埋点                  │
│                                                     │
└─────────────────────────────────────────────────────┘
```

---

## 二、系统总体架构（八层模型）

基于调研报告的"四层解耦"趋势，细化为可工程落地的八层架构：

```
┌──────────────────────────────────────────────────────────────┐
│                     ① 入口层 (Surface)                        │
│    CLI (终端)  │  桌面客户端 (Tauri)  │  Web UI  │  消息平台   │
│         统一通过 WebSocket/HTTP 连接编排层                      │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│                   ② 编排层 (Orchestrator)                     │
│                                                               │
│   意图理解 → 专家路由 → 任务拆解(Plan) → 调度执行 → 异常重试    │
│                                                               │
│   ┌──────────┐  ┌───────────────┐  ┌────────────────────┐    │
│   │ 主 Agent │→ │ 专家路由器     │  │ Team 协调器         │    │
│   │ (通用)   │  │ (选哪个专家)   │  │ (多专家并行/流水线)  │    │
│   └──────────┘  └───────────────┘  └────────────────────┘    │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│                  ③ 智能体层 (Agents)                          │
│                                                               │
│   ┌────────┐ ┌────────┐ ┌──────────┐ ┌──────────┐            │
│   │方案调研│ │ 编码   │ │数据分析  │ │产品运营  │            │
│   │智能体  │ │ 智能体 │ │ 智能体   │ │ 智能体   │            │
│   └────────┘ └────────┘ └──────────┘ └──────────┘            │
│   ┌──────────────┐  ┌──────────────────┐                      │
│   │理财投资智能体 │  │游戏设计开发智能体  │                      │
│   └──────────────┘  └──────────────────┘                      │
│                                                               │
│   每个智能体 = 人设(prompt) + 专属技能集 + 专属MCP + 模型偏好    │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│                   ④ 模型层 (Model)                            │
│                                                               │
│   路由器 ──→ [Claude] [GPT] [DeepSeek] [GLM] [本地Ollama]     │
│                                                               │
│   路由维度：任务复杂度 / 成本预算 / 隐私要求 / 智能体偏好        │
│   动态推理：简单任务省 token，复杂任务投入推理时长               │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│              ⑤ 技能/工具层 (Skills & Tools)                   │
│                                                               │
│   ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐     │
│   │ 内置工具     │  │ MCP Server   │  │ 自定义 Skill    │     │
│   │ (文件/终端/  │  │ (标准化接入  │  │ (SKILL.md      │     │
│   │  Git/Web)   │  │  第三方能力) │  │  可组合可分享)  │     │
│   └─────────────┘  └──────────────┘  └─────────────────┘     │
│                                                               │
│   ToolRegistry 单例：自注册 + 运行时可用性检查 + 动态Schema     │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│                  ⑥ 执行层 (Execution)                         │
│                                                               │
│   本地文件系统  │  Docker 沙箱  │  Python 脚本引擎  │  外部API  │
│                                                               │
│   所有写操作经过安全层审批；沙箱内操作隔离                      │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│                 ⑦ 记忆/持久层 (Memory)                        │
│                                                               │
│   ┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌─────────┐ │
│   │会话状态   │  │ 长期记忆(MD)  │  │FTS5全文  │  │向量检索  │ │
│   │(SQLite)  │  │MEMORY/USER.md│  │(跨会话)  │  │(语义增强)│ │
│   └──────────┘  └──────────────┘  └──────────┘  └─────────┘ │
│                                                               │
│   有界设计：强制优先级管理；冻结快照保前缀缓存有效               │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│                  ⑧ 安全层 (Security)                          │
│                                                               │
│   三模式权限  │  沙箱隔离  │  Hooks 拦截  │  审计日志  │  回滚  │
│   (Ask/Plan/ │            │  (Pre/Post) │            │       │
│    Craft)    │            │             │            │       │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 数据流：一次完整任务的流转

```
用户输入
  │
  ▼
①入口层 ──→ WebSocket 接收消息
  │
  ▼
②编排层 ──→ 主 Agent 理解意图
  │          ├─ 简单问题？→ 直接回答 (Ask 模式)
  │          ├─ 需要执行？→ 专家路由器选择智能体
  │          └─ 复杂任务？→ Team 协调器拆解为子任务
  │
  ▼
③智能体层 ──→ 选中的专家智能体接收任务
  │           ├─ 加载专属 system prompt
  │           ├─ 注入相关 Skills
  │           └─ 组装上下文 (记忆+技能+历史)
  │
  ▼
④模型层 ──→ 路由器选择模型 (按智能体偏好 + 任务复杂度)
  │
  ▼
⑤技能层 ──→ Agent 循环开始
  │          while (有工具调用):
  │            ├─ ⑧安全层: Pre-Hook 拦截 → 权限检查 → 沙箱审批
  │            ├─ ⑥执行层: 执行工具 (文件/MCP/脚本)
  │            ├─ ⑧安全层: Post-Hook → 记录审计日志
  │            └─ ⑦记忆层: 持久化行为轨迹
  │
  ▼
②编排层 ──→ 模型产出最终回复
  │          ├─ ⑦记忆层: 更新会话状态 + 触发摘要压缩(92%)
  │          └─ ⑦记忆层: 异步触发 Skills 沉淀 (复杂任务)
  │
  ▼
①入口层 ──→ 流式返回用户 + 可视化执行过程
```

---

## 三、核心技术模块实现

### 3.1 Agent 循环（系统心脏）

参考 Claude Code 的"简单优先"哲学 + HermesAgent 的同步循环设计：

```typescript
// 核心循环伪代码
async function agentLoop(agent: ExpertAgent, task: Task): Promise<Result> {
  const messages = agent.assembleContext(task);  // 组装上下文
  let iterations = 0;
  const MAX_ITER = agent.maxIterations ?? 50;    // 迭代预算

  while (iterations < MAX_ITER) {
    // 1. 调用模型
    const response = await modelRouter.complete({
      model: agent.preferredModel,
      messages,
      tools: agent.getAvailableTools(),  // 运行时过滤不可用工具
    });

    // 2. 无工具调用 → 循环自然终止
    if (!response.hasToolCalls) {
      return { text: response.text, messages };
    }

    // 3. 上下文压缩检查 (92% 阈值)
    if (contextUsage(messages) > 0.92) {
      await compressContext(messages, agent);
    }

    // 4. 执行工具调用 (可并行)
    const results = await Promise.all(
      response.toolCalls.map(tc => executeTool(agent, tc))
    );

    // 5. 追加结果到消息历史
    messages.push(...formatToolResults(results));
    iterations++;
  }

  return { text: "达到迭代上限", messages, truncated: true };
}
```

**关键设计决策**：

| 决策 | 选择 | 理由（调研依据） |
|------|------|-----------------|
| 同步 vs 异步循环 | **同步** | HermesAgent 证实：瓶颈是 LLM 延迟而非 I/O 并发；同步更易调试 |
| 消息格式 | **OpenAI 标准** | role: system/user/assistant/tool；多模型切换零摩擦 |
| 子 Agent 数量 | **≤3 并行** | HermesAgent 实证：隔离上下文 + 深度≤2 防失控 |
| 压缩阈值 | **92%** | Claude Code 实证值 |
| 参数强转 | **coerce_tool_args()** | HermesAgent：LLM 返回字符串与 JSON Schema 比对自动强转 |

### 3.2 上下文管理（三层记忆）

融合 Claude Code（简单 MD）+ HermesAgent（FTS5 + 有界）+ 调研趋势五（三层记忆）：

```
┌─────────────────────────────────────────────────────┐
│                  三层记忆架构                          │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Layer 1: 工作记忆 (Working Memory)                  │
│  ├── 当前会话上下文 (内存)                            │
│  ├── 92% 触发自动压缩摘要                             │
│  └── 冻结快照：会话开始时捕获，保证前缀缓存有效         │
│                                                     │
│  Layer 2: 情景记忆 (Episodic Memory)                 │
│  ├── SQLite + FTS5 全文索引 (跨会话)                 │
│  ├── LLM 摘要召回 (会话结束自动生成结构化摘要)         │
│  └── 时间衰减加权 (越旧权重越低)                      │
│                                                     │
│  Layer 3: 语义记忆 (Semantic Memory)                 │
│  ├── MEMORY.md — Agent 笔记 (环境/项目/工具知识)      │
│  │   有界：~2200 字符，强制优先级管理                  │
│  ├── USER.md — 用户画像 (偏好/习惯/工作流)            │
│  │   有界：~1375 字符                                 │
│  └── 向量检索 (Qdrant) — 按需启用，语义增强            │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**上下文注入顺序**（参考调研报告 5.2 节 + OpenClaw 四层组装）：

```
系统提示词 (Agent 人设)
  → 项目记忆 (MEMORY.md 快照)
  → 用户画像 (USER.md 快照)
  → 技能列表 (当前可用的 Skills)
  → 历史摘要 (FTS5 检索的相关跨会话记忆)
  → 当前任务描述
  → 用户消息
```

**有界设计的深意**（来自 HermesAgent）：
- 无限记忆 → 系统提示膨胀 → 检索噪声增大 → 前缀缓存失效
- 有界约束 → 迫使 Agent 学会优先级管理：什么值得记住，什么可以遗忘
- 冻结快照 → 写入立即持久化但不改当前会话提示 → Anthropic 等前缀缓存整个会话有效 → 大幅降本

### 3.3 Skills 系统（可组合的能力单元）

参考 OpenClaw SKILL.md + HermesAgent 自创 Skills + agentskills.io 标准：

#### Skill 文件结构

```yaml
# skills/financial/stock-screening/SKILL.md
---
name: stock-screening
version: 1.0.0
author: nexus
triggers:
  - pattern: "选股|筛选股票|找.*股票"
  - intent: "stock_screening"
expert: financial  # 归属智能体
parameters:
  strategy:
    type: enum
    values: [value, growth, dividend, momentum, custom]
    default: value
  market:
    type: enum
    values: [A股, 港股, 美股]
    default: A股
tools_required:
  - westock-tool/filter
  - westock-data/quote
  - mcp__westock-mcp
model_preference: reasoning  # 偏好推理模型
---

# 选股技能

## 工作流
1. 根据策略类型确定筛选条件 (PE/PB/ROE/股息率等)
2. 调用 westock-tool/filter 获取候选列表
3. 调用 westock-data/quote 获取实时行情
4. 按涨跌排序 (注意：涨用红色，跌用绿色——中国市场惯例)
5. 生成结构化报告 (表格 + 图表)

## 注意事项
- 数据时效性：行情数据 15 分钟延迟
- 免责声明：仅供参考，不构成投资建议
```

#### Skill 注册与发现

```typescript
// ToolRegistry 单例 — 仿 HermesAgent 设计
class SkillRegistry {
  private skills = new Map<string, Skill>();

  // 模块导入时自注册
  register(skill: Skill) {
    this.skills.set(skill.name, skill);
  }

  // 运行时可用性检查 — 缺 Key 自动隐藏而非报错
  getAvailableSkills(agent: ExpertAgent): Skill[] {
    return [...this.skills.values()]
      .filter(s => s.expert === agent.type || s.expert === 'common')
      .filter(s => this.checkDependencies(s));  // MCP 连接器是否可用
  }

  // 意图匹配 — 正则优先，语义兜底
  match(input: string, agent: ExpertAgent): Skill[] {
    const available = this.getAvailableSkills(agent);
    // 1. 正则匹配 (简单快速)
    const regexMatches = available.filter(s =>
      s.triggers.some(t => t.pattern && new RegExp(t.pattern).test(input))
    );
    if (regexMatches.length) return regexMatches;
    // 2. 语义匹配 (按需，需向量库)
    return this.semanticMatch(input, available);
  }
}
```

#### Skill 自动沉淀（自进化，Phase 2+）

参考 HermesAgent 闭环学习：
1. **检测**：复杂任务 (多步骤/多工具/成功完成) 触发
2. **记录**：完整 Thought-Action-Observation 轨迹
3. **抽象**：LLM 分析提取可复用模式
4. **生成**：生成 SKILL.md + 触发器 + 参数
5. **验证**：沙箱中执行验证正确性
6. **注册**：存入技能库，后续自动调用

### 3.4 MCP 集成（标准化工具接入）

MCP 是调研中九大产品的共同共识——"一次开发多端复用"。

#### MCP 架构

```
┌─────────────────────────────────────────────────┐
│            AiWorker MCP 客户端                  │
│                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────┐ │
│  │ MCP Manager │→ │ 连接池       │  │健康检查  │ │
│  │ (发现/注册) │  │ (长连接复用) │  │(自动重连)│ │
│  └─────────────┘  └─────────────┘  └─────────┘ │
│                                                 │
│  动态 Schema 重建：                              │
│  execute_code 工具描述会列出沙箱中可用工具        │
│  缺 Key 的 MCP 自动隐藏，不报错                  │
└──────────────────────┬──────────────────────────┘
                       │ stdio / SSE / WebSocket
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
  ┌──────────┐  ┌──────────┐  ┌────────────┐
  │ 本地 MCP │  │ 远程 MCP │  │ 自定义 MCP │
  │ (文件/   │  │ (SaaS    │  │ (自研服务  │
  │  终端)   │  │  连接器) │  │  封装)     │
  └──────────┘  └──────────┘  └────────────┘
```

#### 预置 MCP 连接器矩阵

| MCP Server | 归属智能体 | 提供能力 | 优先级 |
|------------|-----------|---------|--------|
| `filesystem` (本地) | 全部 | 文件读写/搜索 | P0 必备 |
| `terminal` (本地) | 编码/游戏 | 命令执行/脚本 | P0 必备 |
| `github` | 编码 | 仓库管理/PR/Issue | P1 |
| `cnb-api` | 编码 | CNB 代码平台 | P2 |
| `tencent-docs` | 产品运营/调研 | 腾讯文档读写 | P1 |
| `tencent-survey` | 产品运营 | 问卷创建/分析 | P2 |
| `feishu` | 产品运营 | 飞书消息/文档/日历 | P2 |
| `westock-mcp` | 理财投资 | 自选股/行情 | P0 |
| `westock-data` | 理财投资 | 结构化金融数据 | P0 |
| `neodata-financial-search` | 理财投资 | 自然语言金融查询 | P1 |
| `gildata` | 理财投资 | 恒生聚源数据 | P2 |
| `godot-placeholder-animator` | 游戏 | Godot 精灵动画 | P1 |
| `web-search` | 调研/全部 | 网页搜索 | P0 必备 |
| `web-fetch` | 调研/全部 | 网页内容抓取 | P0 必备 |

#### MCP 配置示例

```json
// config/mcp.json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/allowed/path"],
      "env": {}
    },
    "westock-mcp": {
      "command": "npx",
      "args": ["-y", "@westock/mcp-server"],
      "env": { "WESTOCK_TOKEN": "${WESTOCK_TOKEN}" }
    },
    "tencent-docs": {
      "command": "npx",
      "args": ["-y", "@tencent/mcp-docs"],
      "env": { "DOCS_TOKEN": "${DOCS_TOKEN}" }
    }
  }
}
```

缺 Token 的连接器在运行时自动隐藏其工具，Agent 不会产生"幻觉工具调用"（仿 HermesAgent 动态 Schema 重建）。

### 3.5 Hooks 系统（全生命周期扩展点）

参考 Claude Code 的 Hooks 机制，在五个生命周期点提供扩展：

```
┌─────────────────────────────────────────────────────────┐
│                   Hooks 生命周期                          │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  用户消息 ──→ [Hook: onMessage]                          │
│              ├─ 预处理 (敏感信息脱敏/指令解析)            │
│              └─ 注入上下文 (自动加载项目记忆)             │
│                    │                                    │
│                    ▼                                    │
│              Agent 循环开始                               │
│                    │                                    │
│              ┌─────┴─────┐                              │
│              │ 工具调用   │                              │
│              └─────┬─────┘                              │
│                    │                                    │
│         [Hook: onToolCall (Pre)]                        │
│         ├─ 权限检查 (是否允许此操作)                     │
│         ├─ 安全扫描 (危险命令拦截)                       │
│         └─ 审批请求 (Craft 模式下高危操作弹确认)          │
│                    │                                    │
│              ┌─────▼─────┐                              │
│              │ 执行工具   │                              │
│              └─────┬─────┘                              │
│                    │                                    │
│         [Hook: onToolCall (Post)]                       │
│         ├─ 记录审计日志 (谁/何时/做了什么/结果)           │
│         ├─ Diff 捕获 (文件变更快照)                      │
│         └─ 副作用处理 (通知/缓存失效)                    │
│                    │                                    │
│              Agent 循环结束                               │
│                    │                                    │
│         [Hook: onTaskComplete]                          │
│         ├─ 更新会话状态                                  │
│         ├─ 触发记忆持久化                                │
│         └─ 触发 Skills 沉淀评估 (复杂任务)               │
│                    │                                    │
│         [Hook: onError]                                 │
│         ├─ 异常分类 (网络/权限/模型/超时)                 │
│         ├─ 自动重试策略 (指数退避)                       │
│         └─ 降级处理 (切换模型/简化任务)                  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

#### Hook 配置示例

```typescript
// config/hooks.ts
export const hooks: HookConfig = {
  onMessage: [
    { handler: 'sensitiveDataFilter' },      // 敏感信息脱敏
    { handler: 'autoLoadProjectMemory' },     // 自动加载项目记忆
  ],
  onToolCallPre: [
    { handler: 'permissionCheck', mode: 'all' },
    { handler: 'dangerousCommandBlock', tools: ['terminal'] },
    { handler: 'confirmHighRisk', mode: 'craft', 
      patterns: ['rm -rf', 'DROP TABLE', 'git push --force'] },
  ],
  onToolCallPost: [
    { handler: 'auditLog' },
    { handler: 'captureDiff', tools: ['filesystem'] },
  ],
  onTaskComplete: [
    { handler: 'updateMemory' },
    { handler: 'evaluateSkillCreation', threshold: 5 },  // 5步以上任务评估
  ],
  onError: [
    { handler: 'retryWithBackoff', maxRetries: 3 },
    { handler: 'fallbackModel' },
  ],
};
```

---

## 四、六大预置专家智能体

每个智能体 = **人设 (System Prompt)** + **专属技能集** + **专属 MCP** + **模型偏好** + **知识库**

### 4.1 方案调研智能体 (Research Agent)

```
┌─────────────────────────────────────────────────────┐
│              方案调研智能体 (Research)                │
├─────────────────────────────────────────────────────┤
│                                                     │
│  人设：资深研究分析师，擅长系统性调研、对比分析、      │
│        趋势预测。输出结构化报告，结论有据可依。        │
│                                                     │
│  模型偏好：reasoning (推理模型优先，分析深度)         │
│  迭代预算：maxIterations = 80 (长任务)               │
│                                                     │
│  ┌─ 专属技能 ─────────────────────────────────────┐  │
│  │ · web-deep-search    深度搜索 (多轮+综合)       │  │
│  │ · competitive-analysis 竞品对比分析             │  │
│  │ · trend-forecasting   趋势预测                  │  │
│  │ · report-generation   结构化报告生成             │  │
│  │ · citation-tracking   引用溯源                  │  │
│  └────────────────────────────────────────────────┘  │
│                                                     │
│  ┌─ 专属 MCP ─────────────────────────────────────┐  │
│  │ · web-search        网页搜索                    │  │
│  │ · web-fetch         网页内容抓取                 │  │
│  │ · tencent-docs      文档创建/编辑               │  │
│  │ · notion            知识库 (可选)               │  │
│  └────────────────────────────────────────────────┘  │
│                                                     │
│  ┌─ 知识库 ───────────────────────────────────────┐  │
│  │ · 调研方法论框架 (PEST/SWOT/波特五力)           │  │
│  │ · 报告模板库 (技术/市场/产品)                   │  │
│  │ · 历史调研成果 (FTS5 检索复用)                  │  │
│  └────────────────────────────────────────────────┘  │
│                                                     │
│  典型任务：                                          │
│  · "调研 XX 领域主流技术方案，对比优缺点"             │
│  · "分析 XX 产品市场反馈，预测发展趋势"               │
│  · "生成一份 XX 主题的结构化调研报告"                 │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**System Prompt 核心片段**：

```markdown
你是 AiWorker 的方案调研智能体。你的职责是系统性调研、对比分析、趋势预测。

工作原则：
1. 多源交叉验证 — 至少 3 个独立来源才下结论
2. 区分事实与观点 — 事实标注来源，观点标注"分析推断"
3. 结构化输出 — 使用表格/分层标题/对比矩阵
4. 引用溯源 — 每个关键结论附 URL 或来源标记
5. 时效性标注 — 标注信息日期，过期数据明确提示

输出格式：执行概要 → 详细分析 → 对比矩阵 → 结论与建议 → 来源清单
```

### 4.2 编码智能体 (Coding Agent)

```
┌─────────────────────────────────────────────────────┐
│              编码智能体 (Coding)                     │
├─────────────────────────────────────────────────────┤
│                                                     │
│  人设：全栈高级工程师，擅长架构设计、代码实现、        │
│        重构、调试、测试。遵循最佳实践，注重代码质量。   │
│                                                     │
│  模型偏好：coding (编码能力强的模型)                  │
│  迭代预算：maxIterations = 50                        │
│                                                     │
│  ┌─ 专属技能 ─────────────────────────────────────┐  │
│  │ · code-review        代码审查                   │  │
│  │ · refactor           重构 (提取函数/简化逻辑)   │  │
│  │ · debug              调试 (定位/分析/修复)      │  │
│  │ · test-generation    测试生成 (单元/集成)       │  │
│  │ · architecture-design 架构设计                  │  │
│  │ · codebase-analysis  代码库分析 (RepoWiki)      │  │
│  └────────────────────────────────────────────────┘  │
│                                                     │
│  ┌─ 专属 MCP ─────────────────────────────────────┐  │
│  │ · filesystem         文件读写                   │  │
│  │ · terminal           命令执行/构建/测试          │  │
│  │ · github             仓库管理/PR/Issue          │  │
│  │ · cnb-api            CNB 代码平台 (可选)        │  │
│  └────────────────────────────────────────────────┘  │
│                                                     │
│  ┌─ 内置能力 ─────────────────────────────────────┐  │
│  │ · LSP 集成           精准代码理解               │  │
│  │ · Git 操作           版本控制                   │  │
│  │ · AST 解析           代码结构分析               │  │
│  │ · 沙箱执行           安全运行代码               │  │
│  └────────────────────────────────────────────────┘  │
│                                                     │
│  典型任务：                                          │
│  · "实现 XX 功能，遵循项目现有架构"                   │
│  · "重构 XX 模块，提高可维护性"                       │
│  · "修复 XX Bug，附带测试"                           │
│  · "审查这次 PR 的代码质量"                          │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 4.3 数据分析智能体 (Data Analysis Agent)

```
┌─────────────────────────────────────────────────────┐
│            数据分析智能体 (Data Analysis)             │
├─────────────────────────────────────────────────────┤
│                                                     │
│  人设：数据科学家，擅长数据清洗、统计分析、可视化、    │
│        机器学习建模。用数据说话，结论可复现。          │
│                                                     │
│  模型偏好：coding (需写 Python 代码)                 │
│  迭代预算：maxIterations = 60                        │
│                                                     │
│  ┌─ 专属技能 ─────────────────────────────────────┐  │
│  │ · data-cleaning      数据清洗 (缺失值/异常值)   │  │
│  │ · statistical-analysis 统计分析 (描述/推断)     │  │
│  │ · data-visualization 可视化 (matplotlib/echarts)│  │
│  │ · correlation-analysis 相关性分析               │  │
│  │ · time-series        时间序列分析               │  │
│  │ · ml-modeling        机器学习建模 (可选)        │  │
│  │ · sql-query          SQL 查询与分析             │  │
│  └────────────────────────────────────────────────┘  │
│                                                     │
│  ┌─ 专属 MCP ─────────────────────────────────────┐  │
│  │ · filesystem         读写 CSV/Excel/JSON       │  │
│  │ · terminal           Python 脚本执行            │  │
│  │ · database (可选)    SQL 数据库查询             │  │
│  └────────────────────────────────────────────────┘  │
│                                                     │
│  ┌─ 执行环境 ─────────────────────────────────────┐  │
│  │ · Python 沙箱 (预装 pandas/numpy/scikit-learn) │  │
│  │ · matplotlib + echarts 图表生成                 │  │
│  │ · Jupyter 内核 (可选，交互式分析)               │  │
│  └────────────────────────────────────────────────┘  │
│                                                     │
│  典型任务：                                          │
│  · "分析这份销售数据，找出增长趋势和异常点"           │
│  · "清洗这份数据集，生成质量报告"                     │
│  · "用 XX 数据做相关性分析，输出可视化图表"           │
│  · "建立预测模型，评估 XX 指标走势"                   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 4.4 产品运营智能体 (Product Operations Agent)

```
┌─────────────────────────────────────────────────────┐
│           产品运营智能体 (Product Operations)         │
├─────────────────────────────────────────────────────┤
│                                                     │
│  人设：资深产品运营专家，擅长需求分析、文档撰写、      │
│        用户调研、内容创作、活动策划。懂用户，会讲故事。 │
│                                                     │
│  模型偏好：writing (写作能力强的模型)                 │
│  迭代预算：maxIterations = 40                        │
│                                                     │
│  ┌─ 专属技能 ─────────────────────────────────────┐  │
│  │ · prd-writing        PRD 撰写                  │  │
│  │ · user-research      用户调研 (问卷/访谈大纲)   │  │
│  │ · content-creation   内容创作 (文案/推文/文章)  │  │
│  │ · ab-test-analysis   A/B 测试分析               │  │
│  │ · competitive-analysis 竞品分析                 │  │
│  │ · roadmap-planning   路线图规划                 │  │
│  │ · presentation       演示文稿生成               │  │
│  └────────────────────────────────────────────────┘  │
│                                                     │
│  ┌─ 专属 MCP ─────────────────────────────────────┐  │
│  │ · tencent-docs       文档创建/编辑              │  │
│  │ · tencent-survey     问卷创建/回收              │  │
│  │ · feishu (可选)      飞书消息/文档/日历         │  │
│  │ · web-search         竞品/市场搜索              │  │
│  │ · filesystem         本地文件生成               │  │
│  └────────────────────────────────────────────────┘  │
│                                                     │
│  ┌─ 知识库 ───────────────────────────────────────┐  │
│  │ · PRD 模板库 (功能/技术/数据需求)               │  │
│  │ · 运营文案模板库                                │  │
│  │ · 用户画像方法论                                │  │
│  └────────────────────────────────────────────────┘  │
│                                                     │
│  典型任务：                                          │
│  · "写一份 XX 功能的 PRD"                            │
│  · "策划 XX 主题的运营活动方案"                       │
│  · "分析这周的用户反馈，总结共性问题"                 │
│  · "生成 XX 产品的竞品分析报告"                       │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 4.5 理财投资智能体 (Financial Investment Agent)

```
┌─────────────────────────────────────────────────────┐
│           理财投资智能体 (Financial Investment)       │
├─────────────────────────────────────────────────────┤
│                                                     │
│  人设：持证理财顾问 + 量化分析师，擅长基本面分析、    │
│        技术分析、投资组合管理、风险评估。             │
│        严谨客观，始终附带免责声明。                   │
│                                                     │
│  模型偏好：reasoning (推理模型，分析深度)             │
│  迭代预算：maxIterations = 60                        │
│                                                     │
│  ⚠️ 中国市场惯例：涨→红色，跌→绿色 (与欧美相反)      │
│  ⚠️ 货币默认 ¥ (CNY/RMB)                            │
│  ⚠️ 所有投资建议必须附带免责声明                      │
│                                                     │
│  ┌─ 专属技能 ─────────────────────────────────────┐  │
│  │ · stock-screening    选股 (多策略)              │  │
│  │ · fundamental-analysis 基本面分析 (财报/估值)    │  │
│  │ · technical-analysis  技术分析 (MACD/KDJ/RSI)   │  │
│  │ · portfolio-management 投资组合管理              │  │
│  │ · risk-assessment     风险评估                  │  │
│  │ · market-monitor      行情监控 + 预警           │  │
│  │ · financial-report    财报分析                  │  │
│  │ · etf-analysis        ETF 分析                 │  │
│  └────────────────────────────────────────────────┘  │
│                                                     │
│  ┌─ 专属 MCP ─────────────────────────────────────┐  │
│  │ · westock-mcp        自选股/行情                │  │
│  │ · westock-data       结构化金融数据 (A股/港股/   │  │
│  │                       美股/ETF/指数/期货/外汇)  │  │
│  │ · neodata-financial-search 自然语言金融查询     │  │
│  │ · gildata (可选)     恒生聚源数据               │  │
│  └────────────────────────────────────────────────┘  │
│                                                     │
│  ┌─ 知识库 ───────────────────────────────────────┐  │
│  │ · 估值模型库 (DCF/PE/PB/PEG)                   │  │
│  │ · 技术指标库 (MACD/KDJ/布林带/量价关系)         │  │
│  │ · 行业分析框架                                  │  │
│  │ · 历史投资记录 (个人持仓/交易日志)              │  │
│  └────────────────────────────────────────────────┘  │
│                                                     │
│  典型任务：                                          │
│  · "筛选 A 股高股息蓝筹股，按股息率排序"              │
│  · "分析 XX 股票的最新财报，评估投资价值"             │
│  · "我的持仓组合风险评估，建议调仓"                   │
│  · "监控 XX 股票，MACD 金叉时提醒我"                 │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 4.6 游戏设计开发智能体 (Game Design & Development Agent)

```
┌─────────────────────────────────────────────────────┐
│        游戏设计开发智能体 (Game Dev)                  │
├─────────────────────────────────────────────────────┤
│                                                     │
│  人设：游戏设计师 + 技术美术，擅长游戏机制设计、      │
│        关卡设计、数值平衡、Godot/GDScript 开发、       │
│        资源生成。懂游戏 fun，也懂工程实现。            │
│                                                     │
│  模型偏好：creative (创意 + 编码)                     │
│  迭代预算：maxIterations = 70 (长任务)               │
│                                                     │
│  ┌─ 专属技能 ─────────────────────────────────────┐  │
│  │ · game-design-doc    GDD 撰写                  │  │
│  │ · level-design       关卡设计                  │  │
│  │ · character-balance  角色数值平衡              │  │
│  │ · economy-design     经济系统设计               │  │
│  │ · gdscript-coding    Godot/GDScript 编码       │  │
│  │ · sprite-animation   精灵动画生成               │  │
│  │ · scene-architecture 场景架构                  │  │
│  │ · playtest-analysis  试玩分析                  │  │
│  └────────────────────────────────────────────────┘  │
│                                                     │
│  ┌─ 专属 MCP ─────────────────────────────────────┐  │
│  │ · filesystem         项目文件读写               │  │
│  │ · terminal           Godot CLI / 构建执行       │  │
│  │ · godot-placeholder-animator 占位动画生成       │  │
│  │ · ImageGen (可选)    概念图/纹理生成            │  │
│  └────────────────────────────────────────────────┘  │
│                                                     │
│  ┌─ 知识库 ───────────────────────────────────────┐  │
│  │ · Godot 4.x API 参考                           │  │
│  │ · 游戏设计模式 (状态机/组件/ECS)                │  │
│  │ · 数值平衡方法论                                │  │
│  │ · 项目模板 (2D平台/3D冒险/UI框架)               │  │
│  └────────────────────────────────────────────────┘  │
│                                                     │
│  典型任务：                                          │
│  · "设计一个 XX 类型的游戏机制文档"                   │
│  · "为我的 Godot 项目实现 XX 功能"                   │
│  · "平衡这组角色的数值，确保公平性"                   │
│  · "生成 XX 角色的占位动画"                          │
│  · "设计 5 个递进难度的关卡"                         │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 4.7 六大智能体总览对比

| 维度 | 方案调研 | 编码 | 数据分析 | 产品运营 | 理财投资 | 游戏开发 |
|------|---------|------|---------|---------|---------|---------|
| **模型偏好** | reasoning | coding | coding | writing | reasoning | creative |
| **迭代预算** | 80 | 50 | 60 | 40 | 60 | 70 |
| **核心 MCP** | web-search/docs | fs/terminal/github | fs/terminal/db | docs/survey/feishu | westock×3 | fs/terminal/godot |
| **技能数** | 5 | 6 | 7 | 7 | 8 | 8 |
| **沙箱需求** | 低 | 高 | 高(Python) | 低 | 中 | 高 |
| **安全等级** | 只读为主 | 读写+执行 | 执行代码 | 读写文档 | 只读+预警 | 读写+执行 |
| **自进化优先** | 中 | 高 | 中 | 中 | 高 | 高 |

---

## 五、多智能体协作机制

### 5.1 专家路由器

主 Agent 接收用户消息后，通过路由器决定由哪个专家处理：

```typescript
// 路由决策逻辑
async function routeToExpert(input: string): Promise<ExpertAgent> {
  // 1. 正则快速匹配 (优先)
  if (/选股|股票|基金|持仓|行情|财报/.test(input)) return agents.financial;
  if (/重构|实现.*功能|修复.*bug|代码审查|PR/.test(input)) return agents.coding;
  if (/Godot|游戏|关卡|角色.*数值|精灵/.test(input)) return agents.gameDev;
  if (/数据分析|可视化|统计|相关|预测模型/.test(input)) return agents.dataAnalysis;
  if (/PRD|运营|文案|竞品分析|用户调研/.test(input)) return agents.productOps;
  if (/调研|对比.*方案|趋势|报告/.test(input)) return agents.research;

  // 2. LLM 语义路由 (兜底)
  return await llmRoute(input);
}
```

### 5.2 四种协作模式

基于调研报告趋势七的四种 MAS 模式，按任务特征选择：

```
┌─────────────────────────────────────────────────────────┐
│                  多智能体协作模式选择                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ① 单专家模式 (默认)                                     │
│     用户 → 路由器 → [专家A] → 结果                       │
│     适用：明确的单一领域任务                               │
│                                                         │
│  ② 流水线模式 (Pipeline)                                 │
│     用户 → [调研] → [编码] → [测试] → 结果               │
│     适用：有明确先后依赖的链式任务                         │
│     例："调研 XX 技术方案 → 实现原型 → 测试"              │
│                                                         │
│  ③ 并行专家模式 (Parallel)                               │
│     用户 → ┌─[调研]─┐                                   │
│            ├─[数据分析]─┤→ 汇总 → 结果                   │
│            └─[产品运营]─┘                                │
│     适用：多角度同时分析，最后汇总                         │
│     例："从技术/数据/运营三个角度分析这个产品"             │
│                                                         │
│  ④ 辩论模式 (Debate)                                     │
│     用户 → [专家A 给方案] → [专家B 质疑] →               │
│            [专家A 修正] → 综合 → 结果                     │
│     适用：需要多视角碰撞的决策类任务                       │
│     例："这个投资策略是否合理？分析师 + 风控辩论"          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 5.3 Team 协调器

```typescript
// Team 协调器 — 管理多专家协作
class TeamCoordinator {
  async execute(task: ComplexTask): Promise<Result> {
    // 1. 任务拆解 (LLM 辅助)
    const subtasks = await this.decompose(task);

    // 2. 模式选择
    const mode = this.selectMode(subtasks);
    // → pipeline / parallel / debate

    // 3. 分配子任务给专家
    const assignments = subtasks.map(st => ({
      subtask: st,
      expert: this.routeToExpert(st.description),
    }));

    // 4. 执行 (按模式)
    const results = await this.executeByMode(mode, assignments);

    // 5. 汇总
    return await this.synthesize(results);
  }

  // 子 Agent 隔离原则 (仿 HermesAgent)
  // - 每个子 Agent 全新对话，不继承父上下文
  // - 受限工具集 (危险工具剥离)
  // - 深度 ≤ 2，最多 3 并行
  // - 独立迭代预算，不消耗主 Agent 配额
}
```

---

## 六、安全与权限模型

### 6.1 三模式权限

参考 WorkBuddy + Codex + Claude Code 的综合设计：

| 模式 | 文件读取 | 文件写入 | 命令执行 | 网络请求 | 适用场景 |
|------|---------|---------|---------|---------|---------|
| **Ask** | ✅ 允许 | ❌ 禁止 | ❌ 禁止 | ✅ 允许 | 问答/审查/分析 |
| **Plan** | ✅ 允许 | ⚠️ 仅计划文件 | ❌ 禁止 | ✅ 允许 | 接触陌生项目/探索 |
| **Craft** | ✅ 允许 | ✅ 允许 (高危确认) | ✅ 允许 (沙箱) | ✅ 允许 | 自主执行/批量操作 |

### 6.2 安全防护体系

```
┌─────────────────────────────────────────────────────┐
│                  安全防护四层                         │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Layer 1: 权限管控                                   │
│  ├── 工作目录授权 (只允许操作指定目录)                │
│  ├── 三模式切换 (Ask/Plan/Craft)                    │
│  └── 逐工具权限 (每个 MCP 工具可单独授权)            │
│                                                     │
│  Layer 2: 沙箱隔离                                   │
│  ├── Docker 容器 (Linux，代码执行隔离)               │
│  ├── Python venv (数据分析隔离)                     │
│  └── 文件操作快照 (可回滚)                           │
│                                                     │
│  Layer 3: Hooks 拦截                                 │
│  ├── Pre-Hook: 危险命令正则拦截                      │
│  │   (rm -rf / DROP TABLE / git push --force)       │
│  ├── Pre-Hook: 高危操作弹窗确认                      │
│  └── Post-Hook: 文件 diff 捕获 + 审计日志            │
│                                                     │
│  Layer 4: 审计与回滚                                 │
│  ├── 全操作日志 (谁/何时/做了什么/结果)              │
│  ├── 文件变更快照 (可逐步回滚)                       │
│  └── 会话回放 (可复现任意时刻状态)                    │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 6.3 危险操作清单

```typescript
// 默认拦截的高危操作 (Craft 模式下需二次确认)
const DANGEROUS_PATTERNS = [
  // 文件系统
  /rm\s+-rf\s+\//,           // rm -rf /
  /rm\s+-rf\s+~/,            // rm -rf ~
  /del\s+\/s\s+\/q/i,        // Windows del /s /q
  // 数据库
  /DROP\s+(TABLE|DATABASE)/i,
  /DELETE\s+FROM\s+\w+\s*;?\s*$/i,  // 无 WHERE 的 DELETE
  /TRUNCATE\s+TABLE/i,
  // Git
  /git\s+push\s+--force/i,
  /git\s+reset\s+--hard/i,
  // 系统
  /format\s+[a-z]:/i,        // format C:
  /shutdown|reboot/i,
];
```

---

## 七、技术选型与目录结构

### 7.1 技术栈

| 层 | 技术 | 版本 | 理由 |
|----|------|------|------|
| **主语言** | TypeScript | 5.x | 调研共识：OpenCode/Claude Code 均用 TS |
| **运行时** | Node.js | 22.x | LTS，生态成熟 |
| **Agent 框架** | 自研轻量循环 | — | 协议优先于框架，不过度依赖 |
| **模型接口** | OpenAI 兼容格式 | — | 一套接口接所有模型 |
| **会话存储** | SQLite + WAL + FTS5 | — | HermesAgent 实证：零额外依赖 |
| **向量库** | Qdrant (按需) | — | 语义增强，Phase 2 启用 |
| **沙箱** | Docker | — | 代码执行隔离 |
| **Python 环境** | venv 隔离 | 3.13 | 数据分析/ML 执行 |
| **桌面端** | Tauri | 2.x | 轻量 (Rust 后端)，比 Electron 小 10x |
| **CLI** | Commander.js + Inquirer | — | 终端交互 |
| **协议** | MCP (工具) + WebSocket (C/S) | — | MCP 是行业标准 |
| **配置** | YAML + JSON | — | 人可读 + 机器可解析 |

### 7.2 项目目录结构

```
nexus/
├── package.json
├── tsconfig.json
├── config/
│   ├── mcp.json                 # MCP 连接器配置
│   ├── models.json              # 模型路由配置
│   ├── hooks.ts                 # Hooks 配置
│   └── permissions.json         # 权限配置
│
├── src/
│   ├── core/                    # 核心引擎
│   │   ├── agent-loop.ts        # Agent 循环 (系统心脏)
│   │   ├── context-manager.ts   # 上下文管理 (组装/压缩)
│   │   ├── model-router.ts      # 模型路由器
│   │   ├── tool-registry.ts     # 工具注册表 (单例)
│   │   ├── skill-registry.ts    # 技能注册表
│   │   └── team-coordinator.ts  # 多智能体协调器
│   │
│   ├── agents/                  # 六大预置智能体
│   │   ├── base-agent.ts        # 智能体基类
│   │   ├── research-agent.ts    # 方案调研
│   │   ├── coding-agent.ts      # 编码
│   │   ├── data-analysis-agent.ts # 数据分析
│   │   ├── product-ops-agent.ts # 产品运营
│   │   ├── financial-agent.ts   # 理财投资
│   │   ├── game-dev-agent.ts    # 游戏开发
│   │   └── router.ts            # 专家路由器
│   │
│   ├── memory/                  # 记忆系统
│   │   ├── session-store.ts     # 会话状态 (SQLite)
│   │   ├── long-term-memory.ts  # 长期记忆 (MD + FTS5)
│   │   ├── vector-store.ts      # 向量检索 (按需)
│   │   └── compressor.ts        # 上下文压缩 (92% 触发)
│   │
│   ├── mcp/                     # MCP 集成
│   │   ├── mcp-manager.ts       # 连接管理
│   │   ├── connection-pool.ts   # 连接池
│   │   └── health-check.ts      # 健康检查
│   │
│   ├── hooks/                   # Hooks 系统
│   │   ├── hook-manager.ts      # 生命周期管理
│   │   ├── permission-hook.ts   # 权限检查
│   │   ├── audit-hook.ts        # 审计日志
│   │   └── safety-hook.ts       # 安全拦截
│   │
│   ├── security/                # 安全层
│   │   ├── permission-model.ts  # 三模式权限
│   │   ├── sandbox.ts           # 沙箱管理
│   │   ├── danger-detector.ts   # 危险操作检测
│   │   └── audit-log.ts         # 审计日志
│   │
│   └── surfaces/                # 入口层
│       ├── cli/                 # 终端 CLI
│       ├── desktop/             # Tauri 桌面端
│       └── web/                 # Web UI
│
├── skills/                      # 技能库 (SKILL.md)
│   ├── common/                  # 通用技能
│   ├── research/                # 调研技能
│   ├── coding/                  # 编码技能
│   ├── data-analysis/           # 数据分析技能
│   ├── product-ops/             # 产品运营技能
│   ├── financial/               # 理财投资技能
│   └── game-dev/                # 游戏开发技能
│
├── knowledge/                   # 知识库
│   ├── templates/               # 模板库 (PRD/报告/GDD)
│   ├── methodologies/           # 方法论框架
│   └── project-memory/          # 项目记忆 (MEMORY.md)
│
├── data/                        # 运行时数据
│   ├── nexus.db                 # SQLite (会话+FTS5)
│   ├── memory/
│   │   ├── MEMORY.md            # Agent 笔记 (有界)
│   │   └── USER.md              # 用户画像 (有界)
│   └── audit/                   # 审计日志
│
└── tests/
    ├── core/                    # 核心引擎测试
    ├── agents/                  # 智能体测试
    └── e2e/                     # 端到端测试
```

### 7.3 智能体配置文件示例

```yaml
# config/agents/financial-agent.yaml
name: financial-investment
display_name: 理财投资智能体
type: financial
model_preference: reasoning
max_iterations: 60
sandbox: false  # 只读为主，不需要沙箱

system_prompt: |
  你是 AiWorker 的理财投资智能体...
  ⚠️ 中国市场惯例：涨→红色，跌→绿色
  ⚠️ 货币默认 ¥ (CNY/RMB)
  ⚠️ 所有投资建议必须附带免责声明

skills:
  - stock-screening
  - fundamental-analysis
  - technical-analysis
  - portfolio-management
  - risk-assessment
  - market-monitor

mcp_servers:
  - westock-mcp
  - westock-data
  - neodata-financial-search

knowledge_base:
  - knowledge/valuation-models/
  - knowledge/technical-indicators/
  - data/memory/financial-history.md

permissions:
  default_mode: ask  # 理财智能体默认只读
  allowed_tools:
    - westock-tool/filter
    - westock-data/quote
    - westock-data/financial_report
    - web-search
    - web-fetch
  denied_tools:
    - filesystem/write  # 不允许写文件（除非用户明确要求生成报告）
```

---

## 八、实施路线图

### 8.1 四阶段实施计划

```
Phase 1 (第 1-4 周): 核心引擎 MVP
├─ Week 1: Agent 循环 + 模型路由 + 基础工具
│   └─ 交付：能跑通 "指令→工具调用→结果" 闭环
├─ Week 2: 上下文管理 + 会话记忆 + 压缩
│   └─ 交付：多轮对话不断上下文，92% 自动压缩
├─ Week 3: MCP 集成 + 文件系统/终端工具
│   └─ 交付：能读写文件、执行命令
└─ Week 4: 三模式权限 + Hooks + 安全层
    └─ 交付：Ask/Plan/Craft 可用，高危拦截

Phase 2 (第 5-8 周): 六大智能体 + Skills
├─ Week 5: 智能体基类 + 专家路由器
│   └─ 交付：路由器能正确分发任务
├─ Week 6: 编码智能体 + 调研智能体 (最高频)
│   └─ 交付：两个核心智能体可用
├─ Week 7: 数据分析 + 产品运营 + 理财投资 + 游戏开发
│   └─ 交付：六大智能体全部上线
└─ Week 8: Skills 库建设 (每个智能体 5-8 个技能)
    └─ 交付：技能密度 > 40

Phase 3 (第 9-12 周): 多智能体协作 + 长期记忆
├─ Week 9: Team 协调器 + 四种协作模式
│   └─ 交付：流水线/并行/辩论模式可用
├─ Week 10: FTS5 跨会话检索 + LLM 摘要召回
│   └─ 交付：能回忆数周前对话
├─ Week 11: 有界记忆 (MEMORY.md/USER.md) + 冻结快照
│   └─ 交付：前缀缓存有效，成本下降
└─ Week 12: 桌面客户端 (Tauri) + CLI 打磨
    └─ 交付：完整可用的桌面应用

Phase 4 (第 13-16 周+): 自进化 + 生态
├─ Week 13: Skills 自动沉淀 (复杂任务→提炼→注册)
│   └─ 交付：Agent 能从经验中学习
├─ Week 14: 行为轨迹学习 + 用户画像建模
│   └─ 交付：越用越懂用户
├─ Week 15: 向量检索增强 (Qdrant 按需启用)
│   └─ 交付：语义记忆增强
└─ Week 16+: Skill 市场 + 社区生态
    └─ 交付：开放生态，技能可分享
```

### 8.2 里程碑验证指标

| 阶段 | 里程碑 | 验证指标 |
|------|--------|---------|
| Phase 1 | 核心引擎可用 | 单 Agent 任务成功率 > 70% |
| Phase 2 | 六大智能体上线 | 专家路由准确率 > 85% |
| Phase 3 | 多智能体协作 | 复杂任务加速 > 2x (vs 单 Agent) |
| Phase 4 | 自进化启动 | Skills 自动沉淀成功率 > 50% |

### 8.3 风险与应对

| 风险 | 概率 | 应对 |
|------|------|------|
| 模型 API 成本失控 | 高 | 模型分级路由 + Token 预算 + 前缀缓存 + 92% 压缩 |
| 专家路由不准 | 中 | 正则优先 + LLM 兜底 + 用户可手动指定专家 |
| MCP 连接器不稳定 | 中 | 健康检查 + 自动重连 + 缺失时优雅降级 |
| 沙箱跨平台兼容 | 中 | Linux 用 Docker；Windows/macOS 用受限执行模式 |
| 自进化产生低质 Skill | 中 | 沙箱验证 + A/B 测试 + 用户可手动删除 |

---

## 附录 A：调研结论到设计决策的映射

| 调研发现 | 本设计决策 |
|---------|-----------|
| Claude Code "简单优先" | MD + FTS5 先行，向量库按需 |
| HermesAgent 同步循环 | Agent 循环采用同步设计 |
| HermesAgent 有界记忆 | MEMORY.md ~2200 / USER.md ~1375 字符 |
| HermesAgent 冻结快照 | 会话开始捕获快照，保前缀缓存 |
| WorkBuddy 三模式 | Ask / Plan / Craft |
| OpenClaw Skill 生态 | SKILL.md 兼容 agentskills.io |
| MCP 行业共识 | 所有工具走 MCP，不自造协议 |
| CodeBuddy 多智能体 | 六大专家 + 四种协作模式 |
| 趋势：技能密度>200 | Phase 4 目标技能密度>200 |
| 趋势：自进化 | Phase 4 Skills 自动沉淀 |

## 附录 B：六大智能体协作示例场景

**场景：开发一款新的手机游戏**

```
用户："我要做一款放置类手游，帮我从设计到原型全流程推进"

Team 协调器拆解 → 流水线模式：

[游戏开发智能体] 设计核心玩法 + GDD
       │
       ▼
[游戏开发智能体] 实现 Godot 原型 (编码+资源)
       │
       ▼
[数据分析智能体] 设计数值平衡模型 + 模拟
       │
       ▼
[产品运营智能体] 撰写商业化方案 + 运营计划
       │
       ▼
[方案调研智能体] 调研同类竞品 + 差异化建议
       │
       ▼
[理财投资智能体] 预估研发成本 + ROI 分析
       │
       ▼
汇总报告 → 用户审阅
```

---

*本方案基于《AI-Agent应用调研分析与搭建方案.md》的调研结论设计，所有技术决策均有调研依据。*
*设计时间：2026 年 7 月*
