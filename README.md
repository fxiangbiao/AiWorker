# AiWorker

> 个人 AI Agent 助手 — 多智能体协作 + MCP + Skills + Hooks

## 当前状态：Phase 2 进行中

### Phase 1 MVP ✅
核心引擎已实现：
- ✅ **Agent 循环**：同步循环 + 迭代预算 + 92% 压缩
- ✅ **模型路由**：OpenAI 兼容格式，多 profile 路由 (coding/reasoning/writing/creative/lite)
- ✅ **工具注册表**：单例模式 + 运行时可用性检查
- ✅ **上下文管理**：三层记忆 + 冻结快照 + FTS5 检索 + 有界设计
- ✅ **内置工具**：fs_read / fs_write / fs_list / terminal_exec / web_search (Bing 抓取) / web_fetch
- ✅ **安全层**：Ask/Plan/Craft 三模式 + 危险操作拦截 + 审计日志
- ✅ **Hooks 系统**：5 生命周期点 (onMessage / onToolCallPre / onToolCallPost / onTaskComplete / onError)

### Sprint 1 ✅
- ✅ **MCP Manager**：stdio / HTTP 双传输，工具自动发现，失败自动降级
- ✅ **Research Agent**：研究分析智能体 (reasoning 模型，80 迭代上限)
- ✅ **专家路由器**：关键词正则 → LLM 语义两阶段路由

### Sprint 2 ✅
- ✅ **SkillRegistry**：YAML frontmatter 解析，正则触发匹配，运行时依赖降级
- ✅ **Skills × 9**：3 common + 6 research (含 web 深度搜索、竞品分析、趋势预测、报告生成、引用追踪、文件整理)

### Sprint 4 ✅
- ✅ **Data Analysis Agent**：数据分析师 (coding 模型，60 次迭代)
- ✅ **Product Ops Agent**：产品运营专家 (writing 模型，40 次迭代)
- ✅ **Financial Agent**：理财投资顾问 (reasoning 模型，A股惯例，默认 ask)
- ✅ **Game Dev Agent**：游戏设计师 (creative 模型，Godot 4.x 知识库)
- ✅ **Skills × 28**：6 data-analysis + 6 product-ops + 8 financial + 8 game-dev

### Phase 2 六大专家全部就位 🎉

---

## 快速开始

```bash
# 设置 API Key
export OPENAI_API_KEY=sk-...

# 启动
npm run dev

# 或编译后运行
npm run build
npm start

# 指定工作目录和模式
npm start -- --dir /path/to/project --mode craft
```

### 权限模式

| 模式 | 说明 | 工具调用 |
|------|------|---------|
| ask | 纯问答 | ❌ |
| plan | 先列计划，确认后执行 | ❌ (需确认) |
| craft | 自主执行，高危仍需确认 | ✅ |

---

## 项目结构

```
aiworker/
├── plans/                # Sprint 计划文档
├── config/               # 配置文件
│   ├── models.json       # 模型路由配置
│   ├── mcp.json          # MCP 服务器配置
│   ├── permissions.json  # 权限配置
│   └── agents/
│       ├── research.yaml # Research Agent 配置
│       └── coding.yaml   # Coding Agent 配置
├── skills/               # 技能库 (SKILL.md)
│   ├── common/
│   │   └── file-organization/
│   ├── research/
│   │   ├── web-deep-search/
│   │   ├── competitive-analysis/
│   │   ├── trend-forecasting/
│   │   ├── report-generation/
│   │   └── citation-tracking/
│   └── coding/
│       ├── code-review/
│       ├── debug/
│       └── test-generation/
├── src/
│   ├── core/             # 核心引擎
│   │   ├── agent-loop.ts        # Agent 循环
│   │   ├── context-manager.ts   # 上下文管理 (组装/压缩/技能注入)
│   │   ├── model-router.ts      # 模型路由器
│   │   ├── tool-registry.ts     # 工具注册表 (单例)
│   │   ├── skill-registry.ts    # 技能注册表 (单例)
│   │   └── audit-logger.ts      # 审计日志
│   ├── agents/           # 智能体
│   │   ├── base-agent.ts        # 基类
│   │   ├── default-agent.ts     # 通用助手
│   │   ├── research-agent.ts    # 研究分析师
│   │   ├── coding-agent.ts      # 编码工程师
│   │   └── router.ts            # 专家路由器
│   ├── mcp/              # MCP 协议
│   │   └── mcp-manager.ts       # MCP 客户端 (stdio/HTTP)
│   ├── memory/           # 记忆系统
│   │   ├── session-store.ts     # SQLite + WAL + FTS5
│   │   └── compressor.ts        # 92% 压缩
│   ├── tools/
│   │   └── builtin.ts           # 6 个内置工具 (含 Bing 搜索)
│   ├── hooks/
│   │   └── hook-manager.ts      # 5 生命周期 Hook
│   ├── security/
│   │   ├── permission-model.ts  # 三模式权限
│   │   ├── danger-detector.ts   # 危险检测
│   │   └── audit-log.ts         # 审计日志
│   ├── types.ts                 # 核心类型定义
│   └── index.ts                 # CLI 入口
├── data/                 # 运行时数据 (gitignore)
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## 冒烟测试

```bash
npm test
```

**50 项测试**覆盖：工具注册、危险检测、权限模型、会话存储、FTS5、压缩、Hooks、工具执行、路由器 (7 路)、MCP Manager、技能注册表。

---

## 后续阶段

| 阶段 | 内容 | 状态 |
|------|------|------|
| Phase 1 | 核心引擎 MVP | ✅ 完成 |
| Phase 2 | 六大专家智能体 + Skills | ✅ 完成 |
| Phase 3 | 多智能体协作 + 长期记忆 | 待开发 |
| Phase 4 | 自进化 + 生态 | 待开发 |

---

## 技术栈

- **语言**: TypeScript 5.x + Node.js 22.x
- **存储**: SQLite + WAL + FTS5
- **模型**: OpenAI 兼容格式 (支持任意兼容 provider)
- **CLI**: Commander.js + Inquirer
- **搜索**: Bing HTML 抓取 (零 API key)
- **设计依据**: 《个人AI-Agent助手设计方案.md》
