# AiWorker

> 个人 AI Agent 助手 — 多智能体协作 + MCP + Skills + Hooks + 自进化

一套运行在本地的个人 AI Agent 助手：多专家智能体按任务自动路由，支持工具调用、MCP 协议、技能库自动匹配、生命周期 Hook、三层记忆与上下文压缩。提供 **TUI 终端** 与 **Web UI** 两种交互界面，135 项测试全绿。

## 特性

**Agent 核心**
- 流式逐 token 输出 + AbortSignal 中断 + 空响应断路器 + token 压缩（75% 阈值，保留最近 3-8 轮）
- 多 profile 模型路由：coding / reasoning / writing / creative / lite + DeepSeek 思考模式（`extra_body`）
- 7 个专家智能体：通用 / 研究 / 编码 / 数据分析 / 理财 / 游戏 / 产品运营，关键词正则 → LLM 语义两阶段路由
- Team 协调器：`/plan` DAG 编排（4 种模板 + Kahn 环路检测）、`/debate` 双专家互审

**工具与扩展**
- 6 个内置工具：fs_read / fs_write / fs_list / terminal_exec（异步）/ web_search（Bing 零 key）/ web_fetch（15s 超时）
- MCP 协议：stdio/HTTP 双传输 + 内置工具服务器（math_eval/uuid_gen/json_format/timestamp_convert）+ 自动重连 + 健康检查
- 38 个技能（7 大领域）：SKILL.md 正则触发 + 依赖缺失自动降级 + 复杂任务后自沉淀（可开关）

**安全与合规**
- Ask / Plan / Craft 三权限模式 + 危险操作正则拦截 + 路径遍历防护（`--project-dir` 隔离）
- Hooks 5 生命周期点 + 14 个 Handler：敏感数据过滤 / 高危确认 / 权限检查 / Diff 快照 / 审计日志 / 重试退避 / 模型降级

**记忆与上下文**
- 三层记忆：工作记忆（SQLite）+ 情景记忆（FTS5 + 中文分词 + 时间衰减）+ 语义记忆（MEMORY.md/USER.md 有界管理）
- 上下文管理：冻结快照 + 自适应压缩 + 分层 token 占比统计（`/context`）+ 工作目录感知（ProjectProfiler）
- 监控日志：轮次日志（TurnLog）+ 工具调用日志（ToolCallLog），`/log` 查看真实耗时与 token

**交互界面**
- **TUI 终端**：自研帧缓冲渲染引擎（差分渲染 + 组件化 + raw-mode 键解析），Markdown 流式渲染 + 语法高亮 + 表格对齐 + OSC 8 超链接，常驻状态栏
- **Web UI**：Svelte 5 + Vite，SSE 流式，15 组件 + 3 store + DOMPurify XSS 防护
- **HTTP Server**：`--server` 模式提供 REST API，可独立承载 Web UI

---

## 快速开始

环境要求：Node.js >= 22，需要 `DEEPSEEK_API_KEY`。

```bash
# 安装依赖（根目录 + web/）
npm install
cd web && npm install && cd ..

# 方式一：TUI 终端
npm run dev -- --dir /path/to/project --mode craft

# 方式二：HTTP Server + Web UI
npm run dev -- --server --port 3000        # 启动 API（同进程托管 Web UI）
npm run web:dev                             # 另开终端：Web UI 开发模式 :5173
```

### 环境变量

| 变量 | 用途 | 是否必需 |
|------|------|---------|
| `DEEPSEEK_API_KEY` | 默认模型（DeepSeek） | 必需 |
| `OPENAI_API_KEY` | lite 本地模型（`localhost:8000`） | 可选 |

> 其他模型供应商可在 `config/models.json` 中通过 `${ENV_VAR}` 引用环境变量。

### CLI 参数

```
npm run dev -- [选项]
  -m, --mode <ask|plan|craft>   权限模式（默认 craft）
  -d, --dir <目录>               工作目录（工具读写基准）
      --data-dir <目录>          数据目录（默认 ./data）
  -p, --project-dir <目录>       项目输出目录（默认 ./ai_default_project）
      --show-thinking            显示思考过程（默认折叠）
      --server                   启动 HTTP Server（REST API + 托管 Web UI）
      --port <端口>              HTTP Server 端口（默认 3000）
```

### 权限模式

| 模式 | 说明 | 工具调用 |
|------|------|---------|
| ask | 纯问答 | 否 |
| plan | 先列计划，确认后执行 | 否（需确认） |
| craft | 自动执行，高危仍需确认 | 是 |

---

## 交互界面

### TUI 终端

`npm run dev` 直接进入 TUI：下方输入框对话，上方消息区流式渲染，底部常驻状态栏（模式/模型/token/成本/窗口占用进度条）。

| 命令 | 说明 |
|------|------|
| `/mode <ask\|plan\|craft>` | 切换权限模式 |
| `/plan <任务>` | 多专家 DAG 协作 |
| `/debate <话题>` | 双专家辩论 |
| `/skill <名称>` / `/技能名` | 手动激活技能 |
| `/skills` | 查看全部技能（按专家分组 + 描述） |
| `/new` | 开启新会话（清空上下文） |
| `/thinking` | 切换思考展示（折叠/展开） |
| `/log` | 监控日志（轮次/耗时/输入输出 token） |
| `/context [查询]` | 上下文分层 token 占比 + MCP 工具列表 |
| `/status` | 运行状态（模式/模型/token/成本/技能数/排队数） |
| `/config` | 查看/配置模型与系统参数（持久化到 `data/runtime-config.json`） |
| `/skill-evo` | 技能自沉淀开关 |
| `/sessions` / `/switch <序号>` | 浏览 / 切换历史会话 |
| `/copy` | 复制最后回答原始 Markdown |
| `/help` / `/exit` | 帮助 / 退出 |

快捷键：`Ctrl+C` 中断当前运行，`Tab` 补全（`/命令` + 技能名），方向键浏览历史与滚动回看。

### Web UI

```bash
npm run web:build    # 构建 → web/dist/（生产，由 Server 托管）
npm run web:dev      # 开发模式 → localhost:5173（API 代理到 3000）
```

生产部署：`npm run build && npm run start -- --server --port 3000`，浏览器打开 `http://localhost:3000`。

### HTTP API（`--server` 模式）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/chat` | POST | SSE 流式对话（JSON：`message` / `agentId`） |
| `/agents` | GET | 专家列表 |
| `/status` | GET | 运行状态 + token 用量 |
| `/tools` | GET | 已注册工具列表 |
| `/sessions` | GET | 最近 50 个历史会话 |
| `/sessions/:id` | GET | 会话消息明细 |

---

## 项目结构

```
aiworker/
├── config/               # 配置文件
│   ├── models.json       # 模型路由（profiles + 定价 + ${ENV} 引用）
│   ├── agents/           # 6 个 Agent YAML（覆盖 TS 默认配置）
│   ├── mcp.json          # MCP 服务器
│   ├── permissions.json  # 权限规则
│   └── hooks.json        # Hook 注册（14 handlers / 5 events）
├── skills/               # 技能库（38 个 SKILL.md，7 领域 + pending）
├── plans/                # Sprint 设计文档
├── src/
│   ├── core/             # agent-loop / model-router / context-manager /
│   │                     # team-coordinator / skill-registry / skill-evolution ...
│   ├── agents/           # BaseAgent + 7 专家实现 + 路由
│   ├── hooks/            # Hook 管理器 + 配置加载 + 14 个 handler
│   ├── memory/           # session-store（SQLite/FTS5）+ compressor
│   ├── mcp/              # 协议客户端 + 内置服务器 + 重连/健康检查
│   ├── security/         # 危险检测 / 权限模型 / 审计
│   ├── terminal/         # TUI 引擎（screen 帧缓冲 / term 键解析 /
│   │                     # components 组件 / tui 控制器 / markdown / highlight）
│   ├── tools/            # 内置工具
│   ├── server.ts         # HTTP Server + SSE
│   ├── index.ts          # CLI 入口
│   └── types.ts          # 核心类型定义
├── test/                 # 135 项测试（9 文件 + helpers，独立 data 目录防并行冲突）
├── web/                  # Web UI（Svelte 5 + Vite，独立 package.json）
├── data/                 # 运行时数据（gitignored）：aiworker.db / audit.db / 记忆 / 快照
├── ai_default_project/   # Agent 默认输出目录（gitignored）
├── AGENTS.md             # AI 辅助开发指南
└── vitest.config.ts
```

---

## 配置

| 配置 | 文件 | 说明 |
|------|------|------|
| 模型路由 | `config/models.json` | profiles / baseURL / 定价 / 思考模式，支持 `${ENV}` |
| 专家智能体 | `config/agents/*.yaml` | 覆盖 TS 默认（modelPreference 白名单校验） |
| MCP 服务器 | `config/mcp.json` | stdio/HTTP 传输，`enabled: false` 禁用 |
| 权限规则 | `config/permissions.json` | 工具级权限 |
| Hook 注册 | `config/hooks.json` | 14 handlers，支持 `enabled: false` |
| 运行时覆盖 | `data/runtime-config.json` | `/config` 命令持久化，启动自动恢复 |

---

## 测试与开发

```bash
npm test            # vitest run（135 项测试，test/ 目录按模块拆分）
npm run build       # tsc 编译 + 类型检查
npm run lint        # ESLint 检查
npm run web:build   # Web UI 构建
```

测试共享 setup 在 `test/helpers.ts`：每个测试文件独立 `data-test/<name>/` 目录，避免并行 worker 冲突。

---

## 技术栈

- **语言**: TypeScript 5.x + Node.js >= 22（ESM）
- **存储**: better-sqlite3 + WAL + FTS5 + Intl.Segmenter 中文分词
- **模型**: DeepSeek API（默认）+ OpenAI 兼容格式（多 provider）
- **CLI/TUI**: Commander.js + 自研帧缓冲渲染引擎（零依赖）
- **Web UI**: Svelte 5 + Vite 6 + marked + highlight.js + DOMPurify
- **搜索**: Bing HTML 抓取（零 API key）
- **设计依据**: 《个人AI-Agent助手设计方案.md》
