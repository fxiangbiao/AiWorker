# AiWorker

> 个人 AI Agent 助手 — 多智能体协作 + MCP + Skills + Hooks

## 当前状态：Phase 3 已完成

> 最新测试: **85 项** all passed | 最近提交: 2026-08-01

### Phase 1 MVP ✅
核心引擎已实现：
- ✅ **Agent 循环**：同步循环 + 迭代预算 + token 预算压缩 (35% 窗口)
- ✅ **模型路由**：OpenAI 兼容格式，多 profile 路由 (coding/reasoning/writing/creative/lite)
- ✅ **工具注册表**：单例模式 + 运行时可用性检查
- ✅ **上下文管理**：三层记忆 (工作/情景/语义) + 冻结快照 + FTS5 检索 + 有界设计
- ✅ **内置工具**：fs_read / fs_write / fs_list / terminal_exec / web_search (Bing 抓取) / web_fetch
- ✅ **安全层**：Ask/Plan/Craft 三模式 + 危险操作拦截 + 审计日志
- ✅ **Hooks 系统**：5 生命周期点 + 12 个 Handler

### Phase 2 ✅
- ✅ **6 个专家智能体**：通用助手 / 研究分析师 / 编码工程师 / 数据分析师 / 理财投资顾问 / 游戏设计师
- ✅ **37 个技能**：7 大领域 (common / coding / research / data-analysis / financial / game-dev / product-ops)
- ✅ **专家路由器**：关键词正则 → LLM 语义两阶段路由
- ✅ **MCP 协议**：stdio/HTTP 双传输 + 内置工具服务器 (math_eval / uuid_gen / json_format / timestamp_convert)

### Phase 2.5 ✅
- ✅ **流式响应**：逐 token 输出 + AbortSignal 中断
- ✅ **终端渲染器**：底部状态栏 + 输入排队 + 纯 ANSI 转义码

### Phase 3 ✅
- ✅ **Team 协调器**：`/plan` DAG 编排 + 4 种协作模板 + 拓扑执行 + 环路检测
- ✅ **辩论模式**：`/debate <话题>` 双专家独立分析 + 互审 + 综合报告
- ✅ **跨会话记忆**：任务完成自动存入 FTS5 episodic memory，新会话自动检索历史
- ✅ **自适应压缩**：token 预算轮次保留 (min 3, max 8 turns)
- ✅ **MEMORY.md 双段结构**：项目信息段 + 会话历史段 (段落边界安全截断)
- ✅ **USER.md 自动更新**：从对话中提取技术栈/偏好
- ✅ **项目目录隔离**：`--project-dir` 参数，Agent 所有文件输出归入指定目录
- ✅ **安全加固**：并发写互斥锁、连续截断断路器、压缩 LLM 容错 fallback
- ✅ **MCP 重连**：统一调度防风暴 + listener 追踪清理

---

## 快速开始

```bash
# 设置 API Key
export DEEPSEEK_API_KEY=sk-...          # 默认模型
export OPENAI_API_KEY=sk-...            # lite 本地模型 (可选)

# 启动
npm run dev

# 或编译后运行
npm run build
npm start

# 常用参数
npm start -- --dir /path/to/project --mode craft
npm start -- --project-dir ./my_outputs  # Agent 输出目录
```

### 权限模式

| 模式 | 说明 | 工具调用 |
|------|------|---------|
| ask | 纯问答 | ❌ |
| plan | 先列计划，确认后执行 | ❌ (需确认) |
| craft | 自主执行，高危仍需确认 | ✅ |

### 交互命令

| 命令 | 说明 |
|------|------|
| `/mode <ask\|plan\|craft>` | 切换权限模式 |
| `/plan <任务描述>` | 多专家 DAG 协作 (4 种模板匹配 + LLM 生成) |
| `/debate <话题>` | 双专家辩论 (自动匹配最优专家对) |
| `/skill <名称>` | 手动激活技能 |
| `/status` | 显示当前状态 |
| `/help` | 帮助信息 |
| `/exit` | 退出 |

---

## 项目结构

```
aiworker/
├── plans/                # Sprint 计划文档 (sprint-1 ~ sprint-9)
├── config/               # 配置文件
│   ├── models.json       # 模型路由配置 (DeepSeek 默认 + profiles)
│   ├── mcp.json          # MCP 服务器配置
│   ├── permissions.json  # 权限配置
│   ├── hooks.json        # Hook 注册 (12 handlers / 5 events)
│   └── agents/           # 6 个 Agent YAML 配置
├── skills/               # 技能库 (37 个 SKILL.md)
├── scripts/              # 工具脚本
│   └── check-errors.ts   # 数据库诊断工具
├── src/
│   ├── core/             # 核心引擎 (8 文件)
│   ├── agents/           # 智能体 (9 文件)
│   ├── tools/            # 内置工具 (1 文件, 6 工具)
│   ├── mcp/              # MCP 协议 (4 文件)
│   ├── memory/           # 记忆系统 (2 文件)
│   ├── hooks/            # Hook 系统 (3 文件)
│   ├── security/         # 安全层 (3 文件)
│   ├── terminal/         # 终端 UI (3 文件)
│   ├── types.ts          # 核心类型定义
│   ├── index.ts          # CLI 入口
│   └── smoke-test.ts     # 冒烟测试 (85 tests)
├── data/                 # 运行时数据 (gitignored)
├── ai_default_project/   # Agent 默认输出目录 (gitignored)
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## 冒烟测试

```bash
npm test
```

**85 项测试**覆盖：工具注册、危险检测、权限模型、会话存储、FTS5、压缩、Hooks、工具执行、路由器、MCP Manager、技能注册表、Streaming + 终端、Phase 3 Hook 处理器、Team 协调器、记忆系统增强、MCP 工具服务器。

---

## 后续阶段

| 阶段 | 内容 | 状态 |
|------|------|------|
| Phase 1 | 核心引擎 MVP | ✅ 完成 |
| Phase 2 | 六大专家智能体 + Skills | ✅ 完成 |
| Phase 2.5 | 终端交互升级 (Streaming + 状态栏 + 排队) | ✅ 完成 |
| Phase 3 | 多智能体协作 + 记忆增强 + 辩论模式 | ✅ 完成 |
| Phase 4 | 自进化 + 生态 | 待开发 |

---

## 技术栈

- **语言**: TypeScript 5.x + Node.js 22.x
- **存储**: SQLite + WAL + FTS5 + 中文分词 (Intl.Segmenter)
- **模型**: DeepSeek API (默认) + OpenAI 兼容格式 (多 provider)
- **CLI**: Commander.js + Inquirer
- **搜索**: Bing HTML 抓取 (零 API key)
- **设计依据**: 《个人AI-Agent助手设计方案.md》
