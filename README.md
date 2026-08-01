# AiWorker

> 个人 AI Agent 助手 — 多智能体协作 + MCP + Skills + Hooks + 自进化

## 当前状态: Sprint 11

> 85 项测试全绿 | 最近修复: 2026-08-01 (Code Review 两轮, 20 项修复)

### 已实现

- **Agent 循环**: 流式逐 token 输出 + AbortSignal 中断 + 空响应断路器 + token 压缩 (35% 窗口)
- **模型路由**: OpenAI 兼容格式, 多 profile (coding/reasoning/writing/creative/lite), 流式 token 计数
- **工具系统**: 单例注册表 + 运行时可用性检查 + 参数类型自动转换
- **6 个内置工具**: fs_read / fs_write / fs_list / terminal_exec (异步) / web_search (Bing) / web_fetch (15s 超时)
- **MCP 协议**: stdio/HTTP 双传输 + 内置工具服务器 (math_eval/uuid_gen/json_format/timestamp_convert) + 自动重连 + 健康检查
- **权限模式**: Ask / Plan / Craft 三模式 + 危险操作正则拦截 + 路径遍历防护
- **7 个专家智能体**: 通用助手 / 研究分析师 / 编码工程师 / 数据分析师 / 理财投资顾问 / 游戏设计师 / 产品运营
- **专家路由**: 关键词正则 (weighted) → LLM 语义兜底, 两阶段路由
- **37 个技能**: 7 大领域 (common/coding/research/data-analysis/financial/game-dev/product-ops), SKILL.md 正则触发匹配
- **Team 协调器**: `/plan` DAG 编排 + 4 种内置模板 + Kahn 环路检测 + 死锁检测
- **辩论模式**: `/debate <话题>` 双专家独立分析 + 互审 + 综合报告, 自动匹配最优专家对
- **Hooks 系统**: 5 生命周期点 + 14 个 Handler (敏感数据过滤/高危确认/权限检查/Diff 快照/审计日志/重试退避/模型降级/记忆更新/技能评估/监控日志)
- **三层记忆**: 工作记忆 (SQLite) + 情景记忆 (FTS5 + 中文分词 + 时间衰减) + 语义记忆 (MEMORY.md/USER.md 有界管理)
- **上下文管理**: 冻结快照 + 自适应压缩 (min 3, max 8 turns) + 分层 token 占比统计 (`/context`)
- **工作目录感知**: ProjectProfiler 启动扫描项目类型/包管理器/测试框架/关键文件, 注入 system prompt
- **项目目录隔离**: `--project-dir` 参数, Agent 文件输出归入指定目录 + 路径遍历防护
- **技能自进化**: 复杂任务后自动沉淀 SKILL.md (M2), 支持配置开关 (`hooks.json` + `/skill-evo` 命令)
- **监控日志**: 轮次日志 (TurnLog) + 工具调用日志 (ToolCallLog), SQLite 持久化, `/log` 命令查看
- **终端 UI**: 流式输出 + 状态栏 + spinner + 思考展示折叠 + 输入排队 + CJK 对齐 + Windows raw mode 兼容
- **安全加固**: 并发写互斥锁、连续截断断路器 (3次)、FTS5 注入防护、`new Function()` 沙箱白名单

---

## 快速开始

```bash
npm run dev                          # tsx 直接运行 CLI
npm run build                        # tsc → dist/
npm start                            # 编译后运行

# 常用参数
npm start -- --dir /path/to/project --mode craft
npm start -- --project-dir ./outputs --data-dir ./mydata
npm start -- --show-thinking
```

### 环境变量

```bash
export DEEPSEEK_API_KEY=sk-...       # 默认模型 (必需)
export OPENAI_API_KEY=sk-...         # lite 本地模型 (可选, localhost:8000)
```

### 权限模式

| 模式 | 说明 | 工具调用 |
|------|------|---------|
| ask | 纯问答 | 否 |
| plan | 先列计划, 确认后执行 | 否 (需确认) |
| craft | 自动执行, 高危仍需确认 | 是 |

### 交互命令

| 命令 | 说明 |
|------|------|
| `/mode <ask\|plan\|craft>` | 切换权限模式 |
| `/plan <任务描述>` | 多专家 DAG 协作 |
| `/debate <话题>` | 双专家辩论 |
| `/skill <名称>` | 手动激活技能 |
| `/new` | 开启新会话 (清空上下文) |
| `/thinking` | 切换思考展示 (折叠/展开) |
| `/log` | 查看当前会话监控日志 |
| `/context [查询]` | 上下文分层 token 占比 + MCP 工具列表 |
| `/skill-evo` | 技能自动沉淀开关 |
| `/status` | 显示运行状态 (模式/模型/token/成本) |
| `/help` | 帮助信息 |
| `/exit` | 退出 |

---

## 项目结构

```
aiworker/
├── plans/                # Sprint 计划文档
├── config/               # 配置文件
│   ├── models.json       # 模型路由 (DeepSeek + profiles + 定价)
│   ├── mcp.json          # MCP 服务器
│   ├── permissions.json  # 权限规则
│   ├── hooks.json        # Hook 注册 (14 handlers / 5 events)
│   └── agents/           # 6 个 Agent YAML (coding/research/data/financial/game/product-ops)
├── skills/               # 技能库 (37 个 SKILL.md, 7 领域)
├── scripts/              # 工具脚本
│   └── check-errors.ts   # 数据库诊断
├── src/
│   ├── core/             # 核心引擎 (10 文件)
│   │   ├── agent-loop.ts
│   │   ├── model-router.ts
│   │   ├── context-manager.ts
│   │   ├── team-coordinator.ts
│   │   ├── skill-registry.ts
│   │   ├── skill-evolution.ts
│   │   ├── project-profiler.ts
│   │   ├── tool-registry.ts
│   │   ├── audit-logger.ts
│   │   └── agent-config-loader.ts
│   ├── agents/           # 智能体 (9 文件)
│   │   ├── base-agent.ts
│   │   ├── default-agent.ts
│   │   ├── research-agent.ts
│   │   ├── coding-agent.ts
│   │   ├── data-analysis-agent.ts
│   │   ├── financial-agent.ts
│   │   ├── game-dev-agent.ts
│   │   ├── product-ops-agent.ts
│   │   └── router.ts
│   ├── hooks/            # Hook 系统 (3 文件)
│   │   ├── hook-manager.ts
│   │   ├── hook-config-loader.ts
│   │   └── handlers.ts
│   ├── memory/           # 记忆系统 (2 文件)
│   │   ├── session-store.ts
│   │   └── compressor.ts
│   ├── mcp/              # MCP 协议 (4 文件)
│   │   ├── mcp-manager.ts
│   │   ├── builtin-server.ts
│   │   ├── connection-pool.ts
│   │   └── health-check.ts
│   ├── security/         # 安全层 (3 文件)
│   │   ├── danger-detector.ts
│   │   ├── permission-model.ts
│   │   └── audit-log.ts
│   ├── terminal/         # 终端 UI (3 文件)
│   │   ├── renderer.ts
│   │   ├── input.ts
│   │   └── ansi.ts
│   ├── tools/            # 内置工具 (1 文件)
│   │   └── builtin.ts
│   ├── types.ts          # 核心类型定义 (362 LOC)
│   ├── index.ts          # CLI 入口
│   └── smoke-test.ts     # 冒烟测试 (85 tests)
├── data/                 # 运行时数据 (gitignored)
├── ai_default_project/   # Agent 默认输出目录 (gitignored)
├── AGENTS.md             # AI 辅助开发指南
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## 冒烟测试

```bash
npm test      # vitest run, 85 tests
npm run build # tsc 编译 (含类型检查)
```

---

## 技术栈

- **语言**: TypeScript 5.x + Node.js >= 22
- **存储**: better-sqlite3 + WAL + FTS5 + Intl.Segmenter 中文分词
- **模型**: DeepSeek API (默认) + OpenAI 兼容格式 (多 provider)
- **CLI**: Commander.js + 自研终端渲染器 (纯 ANSI 转义码)
- **搜索**: Bing HTML 抓取 (零 API key)
- **设计依据**: 《个人AI-Agent助手设计方案.md》

---

## 后续阶段

| Sprint | 内容 | 状态 |
|--------|------|------|
| 1-3 | 核心引擎 (Agent 循环/模型路由/工具/上下文) | 完成 |
| 4-5 | 六大专家 + Skills + MCP | 完成 |
| 6-7 | 流式终端 + 多智能体协作 + 记忆增强 | 完成 |
| 8-9 | TUI 修复 + Team 协调器增强 | 完成 |
| 10 | TUI 缺陷修复 + stdin 冻结/endLiveStatus/thinkingFirstLine/token 计数/log 映射/CJK 对齐 | 完成 |
| 11 | 多轮会话/技能自进化/目录感知/监控日志/上下文透明 | 完成 |
| — | Code Review 两轮 (20 项修复) | 完成 |
| M2.1 | 技能自动沉淀 v2 (LLM 知识提取) | 待实施 |
