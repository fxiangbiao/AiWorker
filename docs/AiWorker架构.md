# AiWorker 架构

> 版本 1.9.0 · 2026-09
> 本文是 AiWorker 的**唯一正式架构文档**，演进过程见 [plans/sprint-history.md](../plans/sprint-history.md)。
>
> 一句话：**AI 是大脑、Harness 是手脚、应用是进程、一切皆可即时生成、用完即毁。**

## 目录

1. [设计理念](#一设计理念)
2. [总体架构](#二总体架构)
3. [认知内核](#三认知内核大脑)
4. [执行层](#四执行层手脚)
5. [子智能体](#五子智能体后台并行)
6. [应用模型与安全](#六应用模型与安全)
7. [会话与记忆](#七会话与记忆)
8. [进化闭环](#八进化闭环自进化)
9. [安全与权限模型](#九安全与权限模型)
10. [交互与界面](#十交互与界面)
11. [工程约定](#十一工程约定)
12. [快速开始](#十二快速开始)
13. [目录结构](#十三目录结构)
14. [版本演进](#十四版本演进)

---

## 一、设计理念

### 1.1 五条铁律（源自业界调研）

| # | 铁律 | 落地 |
|---|------|------|
| 1 | 先做简单的事 | 记忆用 SQLite FTS5 + Markdown，不提前上向量库 |
| 2 | 协议优先于框架 | 工具走 MCP 标准接入，循环自研轻量实现 |
| 3 | 技能 ≠ API | SKILL.md 描述能力，模型运行时动态组合 |
| 4 | 越用越聪明是护城河 | 轨迹学习 + 有界记忆 + 进化引擎闭环 |
| 5 | 安全是落地前提 | Day 1 内置三模式权限 + 沙箱 + Hooks 拦截 + 审计 |

### 1.2 AI OS 三条铁律

| # | 铁律 | 落地原则 |
|---|------|---------|
| 1 | **AI 是大脑，Harness 是手脚** | 认知内核只做决策，不直接碰文件/进程；一切执行走工具层，可审计、可拦截、可回滚 |
| 2 | **插件机制是扩展，支持自进化** | 统一为应用模型（tool/skill/agent/service/app 五类）；进化引擎能自己生成新应用/新工具并自我检验 |
| 3 | **应用可即时生成，用完留存或销毁** | AppFactory：描述 → 生成 → 校验 → 安装 → 运行 → keep/destroy；destroy 是干净移除（代码+进程+权限+审计全清） |

核心设计原则：**模型无关**（OpenAI 兼容接口 + profile 路由）、**工具标准化**（MCP 热插拔、缺 Key 自动降级）、**记忆有界**（优先级管理保前缀缓存）、**渐进信任**（ask → plan → auto 三模式）、**可观测**（每步 diff/日志、Hooks 全生命周期埋点）。

---

## 二、总体架构

![AiWorker 总体架构：用户 → 交互层 → 认知内核（大脑）→ 权限裁决 → 执行层（手脚）→ 进程层；左侧为记忆与审计、进化闭环、AppFactory；右侧为模型路由、LLM Provider、子智能体](diagrams/aiworker-architecture.svg)

> 交互式版本（可搜索、聚焦链路、明暗主题、导出 PNG/SVG/WebM）：[aiworker-architecture.html](diagrams/aiworker-architecture.html) · 图规格与源码证据索引：[aiworker-architecture.json](diagrams/aiworker-architecture.json)

关键决策：认知内核不直接感知"应用"，只通过工具/事件与进程层交互——应用是"会自己干活、有生命周期、可被销毁的工具集合"。

---

## 三、认知内核（大脑）

### 3.1 Agent 循环

`core/agent-loop.ts` 是系统心脏：接收消息 → 组装上下文 → 调模型 → 解析工具调用 → 执行 → 回填结果 → 迭代，直到产出最终回答或达到迭代预算。要点：

- **迭代预算**：扩容 + 运行时可调 + 智能收敛（Sprint 29），`endStep()` 必须先于 `iterations++`
- **seam 改造**（Sprint 23）：LLM Provider 抽象层，一套 OpenAI 兼容接口接所有模型，按 profile 路由
- **执行层硬校验**：`executeToolInner` 对每次工具调用核对可见集合（`visibleSet`），不在集合内直接拒绝并记审计（`result:"blocked"`）——工具白名单从"提示性"升级为"强制性"
- **中断传播**：`AgentLoopDeps.signal` → `ToolContext.signal`，`terminal_exec` 响应 abort 并按进程树杀（win32 `taskkill /T /F`、POSIX 进程组 SIGKILL）

### 3.2 专家智能体

7 个内置专家（方案调研 / 编码 / 数据分析 / 产品运营 / 理财投资 / 游戏设计 / default 通用）+ GenericAgent 自定义。每个智能体 = 人设 prompt + 专属技能集 + 工具白名单 + 模型偏好：

- 配置**唯一来源** `config/agents/<id>.yaml`（内置 TS 默认 + YAML 覆盖，无运行时覆盖层）
- `reloadAgent(id)` 热重载免重启
- 工具白名单 `filterVisibleTools`：mcp 前缀匹配 + strictTools 豁免规则；受限工具需显式列出；`readOnly` 走闭集

### 3.3 多智能体协作

- **专家路由器**：按意图选择专家
- **四种协作模式**：单播 / 广播 / 流水线 / 辩论（`/debate`）
- **Team 协调器**（`team-coordinator`）：多专家 DAG 并行编排（`/plan`）

### 3.4 模型路由

`model-router` 管理 profile（`config/models.json`）：key / provider / baseURL / apiKey / model / adapter（openai-compatible 等）。profile key 一律**小写存储与比较**；运行时经 `runtimeProfileKey` 切换，`getProfile()` 合并 provider 端点后生效。Web 设置页与 CLI `/config model <key>` 共用同一入口（写侧字段 `model`，别名 `profileKey`）。

---

## 四、执行层（手脚）

### 4.1 内置工具（`src/tools/`）

9 个内置：`fs_read` / `fs_write` / `fs_edit` / `fs_list` / `terminal_exec` / `terminal_session` / `web_search` / `web_fetch` / `ask_user`。MCP 工具命名 `mcp_{server}_{tool}`。`ToolResult = { success, content, error? }`。

- **ToolRegistry 单例**：自注册 + 运行时可用性检查 + 动态 Schema
- **ToolContext.signal** 供工具响应中断
- 高危工具（`terminal_exec` / `terminal_session` / `fs_write` / `fs_edit`）进 `DANGER_TOOLS`，任何模式下强制确认；`fs_*` 的危险判定只看路径

### 4.2 MCP 集成（`src/mcp/`）

标准化工具接入，配置文件驱动，缺 Key 自动降级而非报错。

### 4.3 Skills 系统

`skills/<name>/SKILL.md` 描述能力（工作流 + 注意事项），运行时注入提示词动态组装；兼容 agentskills.io 生态；`.aw` 资产包可分发（zip + manifest，`/pkg export` / `/install`）。

### 4.4 Hooks 系统

全生命周期扩展点（`HookResult = { proceed, modifiedData?, message? }`）：PreToolUse / PostToolUse / 会话事件等。`hooks/handlers.ts` 承担检查点记录（工具写文件前后快照）、审批钩子、审计联动。

### 4.5 插件

`pluginManager` 加载 `.aw` / 裸格式插件，`setup(ctx)` fail-soft（单个插件失败不拖垮启动）。scoped 工具注册限定作用域。

---

## 五、子智能体（后台并行）

Sprint 52 引入，`core/subagent-runner.ts` 状态机 `queued → running → idle | failed`：

- **控制面 4 工具**（`subagent-tools.ts`）：`spawn_agent` / `send_message` / `list_agents` / `interrupt_agent`。主 agent 默认白名单开通（opt-in）；worker 子代调用一律拒绝（深度 1）
- **隔离**：子会话 `wk-` 前缀独立 session；每次 spawn 经 `BaseAgent.fork()` 深拷贝配置派生实例
- **轮边界注入**：运行中 `send_message` 在 step 边界送达；`interrupt` 后补发消息会自动重新排队
- **安全不降级**：受限工具双层校验（`subagent-rules.ts` 常量 + 执行层 `visibleSet` 硬校验）；HTTP 控制端点带写门禁（token + 403/401/400）
- **可撤销**：子会话写登记到父 spawn turn 的 manifest（`subagent-ownership.ts`），父 `/rewind N` 连带回滚；父空闲时 spawn 的子写不可回滚（manifest 缺失 → `checkpoint:rejected` 审计，诚实边界）
- **可观测**：`processManager.stats()` 含 `subagent` 计数，Web 进程面板实时可见；`?purge=1` 关闭续接资格
- **约束**：并发上限 4（只计 queued/running）；deny-provider 有 10 分钟 run watchdog + 5s 关停宽限

---

## 六、应用模型与安全

### 6.1 应用模型

manifest 落 `data/apps/<id>/app.json`，五类应用：**tool / skill / agent / service / app(webapp)**；`entry` + 权限声明 + 工具声明。

### 6.2 进程模型（一切皆进程）

Agent 会话 / 应用 / 后台任务 / 定时任务 / 子智能体统一由 `processManager` 登记（`process/start|update|end` 广播），Web「进程」视图实时可见，附带 token 资源仪表。

- 生命周期：`installed → starting → running → stopping → stopped`；`destroyed` 终态
- 崩溃恢复：service/app 子进程意外退出 → 心跳检测 → 指数退避重启（1s/2s/4s，≤3 次）→ 仍失败置 failed 告警

### 6.3 隔离与权限

- tool/service 跑**子进程**，stdin/stdout 行分隔 JSON-RPC，白名单能力桥（storage/notify/llm/fs/http，**无 terminal**）
- webapp 走沙箱 iframe（origin="null"，宿主回发 postMessage 的 targetOrigin 必须 `"*"`，见 `web/src/lib/app-bridge.ts`）
- 权限 = 静态声明（manifest 预授权）+ 运行时申请（ask 通道），均记审计；能力强制层：storage 自动允许，其余须声明命中
- 运行时限制：工具调用 60s 超时、`resourceLimits` 内存上限、stdout 截断

### 6.4 即时生成（AppFactory）

描述 → 生成 agent → 校验（JS 语法 / manifest / 权限白名单）→ 安装 → 运行 → keep/destroy。生成期安全：权限上限模板硬编码 + 独立最小化系统提示（防上下文注入）+ 权限声明审查。webapp 采用**多文件约定目录**（index.html + app.js + style.css，分块生成），零构建直接静态服务。

---

## 七、会话与记忆

### 7.1 事件溯源

`session_events` 表**仅追加**，是唯一真源：消息/轮次/工具/记忆均为投影（Sprint 24）。SQLite(WAL) + FTS5。

### 7.2 三层记忆

| 层 | 载体 | 说明 |
|---|------|------|
| 工作记忆 | 会话内上下文 | 受 context-manager 压缩/修剪 |
| 情景记忆 | SQLite FTS5 | 跨会话检索 |
| 语义记忆 | MEMORY.md | 有界设计，强制优先级管理，保前缀缓存有效 |

### 7.3 每会话项目目录

`sessions.working_dir` 列（旧库自动 ALTER 迁移）：CLI `/dir <绝对路径>` 或 Web 会话控制条 📁 编辑器设置。fs 工具 / 沙箱根 / 审批基线 / 文档面板项目根全部跟随该会话，未设置回退全局 `--dir`。

### 7.4 检查点与回滚

`checkpoint-store.ts`：turn 级 manifest 登记写操作，`/rewind N` 一键还原；manifest 不存在时 `capture()` 返回 null 不隐式创建（拒绝伪造回滚锚点）。子智能体的写经归属登记并入父 spawn turn（见 §五）。

---

## 八、进化闭环（自进化）

```
Observe 观察（7 天窗口派生指标，零新增存储）
   ↓ 工具成功率/耗时/失败原因 · 任务完成率 · 重复任务聚类 · 用户干预 · 生成统计
Propose 提议（meta-agent → 结构化提案，schema 校验，每日 ≤3 条限频）
   ↓ new-skill / new-tool / new-app / config-change / tool-fix / prompt-fix
Adopt 确认（两段式：adopt 仅预览不写入 → apply 才真正执行）
   ↓ 写入前自动快照 data/evolution/snapshots/<id>.json
Apply 生效（技能落盘 / 工具描述热覆盖 / 提示词 YAML+热重载 / 生成任务 / 配置字段）
   ↓
Rollback 回滚（applied → rolled_back 终态，快照一键还原，审计+广播）
   ↓
Diff 变更对比（before=快照 / after=提案，行级 LCS）
   ↓
Eval 黄金用例评测（成功会话按 turn 沉淀 + 手工补录；裁判注入；before 双轨）
   ↓
Verify 推广后验证（完整 A/B → 回归超阈值 → 自动回滚，全程审计广播）
```

**护栏**：提案仅建议、用户确认；高影响变更两段式；限频 + 快照保留；全部动作审计 + `evolution/*` 广播；路径穿越三层防护；config-change 白名单字段（`model` / `addModel` / `temperature` / `maxTokens` / `thinking` / `skillEvo` / `reset`）。

---

## 九、安全与权限模型

### 9.1 三模式权限矩阵

`permissionModel` 提供 ask / plan / auto 三模式（`config/permissions.json` 规则化，项目级可覆盖，`/permissions` 查看来源/撤销/清空）：

- **fail-closed**：无确认通道时自动拒绝（`reason:"no-channel"`），不放行
- `never_auto_approve`：如 `spawn_agent` / `send_message` 永不自动批准（当前无 always-allow 旁路，属有意保守）
- 危险操作清单（`DANGER_TOOLS`）任何模式强制确认

### 9.2 安全防护体系

| 层 | 机制 |
|---|------|
| 执行沙箱 | `config/sandbox.json` 策略（Windows 最小沙箱 / POSIX rlimits） |
| 路径策略 | 单点判定（Sprint 49）：工作目录/dataDir 边界 + 符号链接能力探测 |
| 审计 | `audit.db`（append-only），含 `actor_session_id` 列区分父子会话 |
| 确认通道 | ApprovalService：WS/SSE 推送 → 用户裁决 → 超时/无通道按 fail-closed 处理 |
| 应用能力 | 强制层无 terminal（§6.3） |

### 9.3 危险操作清单

文件写/编辑越界、终端命令、包安装、调度写入等进入审批流；审批被拒时跳过检查点记录（`captureRejected` 映射），不留脏快照。

---

## 十、交互与界面

### 10.1 TUI（`src/terminal/`）

自研帧缓冲渲染：差分刷新 + CJK 宽字符（`screen.ts`）；markdown OSC8 超链接 wrap 保持转义序列完整（`markdown.ts`）；块式会话视图（思考/工具/回答可折叠，Sprint 45）。

### 10.2 Web UI（`web/`）

Svelte 5 + Vite；API 前缀 `/api/v1`；WS 实时总线 `/api/v1/ws`（chat SSE + eventBus 双写）；store 在 `lib/stores/`。布局：左侧导航（对话/应用/进程/任务）+ 右侧面板（文件变更/文档预览/应用预览）+ SystemPanel 多 Tab（上下文/智能体/技能/MCP/插件/应用/进程/设备/进化/调度/配置/轨迹/审计）。信息架构：设置与控制台分离（web-ia-restructure）。

### 10.3 设备（`src/media/`）

- **语音输入**：sherpa-onnx paraformer-zh 离线 ASR，Web 按住说话→识别回填；模型经 hf-mirror 下载或手动放置 `data/media/models/asr/`
- **TTS**：sherpa vits-zh-ll 离线优先 / edge-tts 在线降级，WS 音频通道 + Web speechSynthesis 兜底
- `/media status|download`；模型多模态能力展示

### 10.4 HTTP API 与 Server

`src/server.ts`：chat（SSE）、sessions、files/docs（`root=session|project` 双根）、config、agents、subagents（4 控制端点 + 写门禁）、approvals、processes、WS 总线。headless 模式（Sprint 48）支持无 TUI 运行。

### 10.5 CLI 速查

```
/mode /plan /debate         权限模式 / DAG 协作 / 辩论
/app /bg /jobs /schedule    应用生命周期+生成 / 后台任务 / 定时（自然语言 cron）
/install /pkg               安装 .aw 或裸格式 / 打包导出
/permissions                权限规则：列出（含来源）/ 写项目级 / 撤销 / 清空
/evo /export /rewind /dir   进化 / 导出会话 / 回滚 / 会话项目目录
/skill(s) /setup /new /sessions /trace /config /media /help /exit
```

CLI 参数：`--dir`（默认 ./ai_default_project）`--data-dir` `--mode` `--show-thinking` `--server` `--port`

---

## 十一、工程约定

- **ESM**：相对导入必须带 `.js` 扩展名（tsx 宽容，dist/ 报错）
- **单例**：ToolRegistry / HookManager / McpManager / SkillRegistry / pluginManager / jobRunner / subagentRunner / scheduler / packageInstaller 经 `.getInstance()` 或导出常量访问
- **kebab-case** 文件名；领域类型集中 `src/types.ts`（`import type`）；不加注释除非绝对必要
- **Svelte 5**：改 store 数组元素必须经 store 取代理引用回写
- **cron-parser v5 为 6 字段**（5 字段自动补秒前缀）
- 验证闸门：`npm run verify` = build + lint + test + web:build + check:web
- 测试：`makeTestDir(name)` 独立 `data-test/`；端点测试 mock deps + `listen(0)` + fetch；需要链接权限的用例走 `helpers.ts` 能力探测 + `it.skipIf`

---

## 十二、快速开始

```bash
npm install
# 配置 DEEPSEEK_API_KEY（.env），OPENAI_API_KEY 可选
npm run dev            # CLI（tsx，无需编译）
npm run dev -- --server --port 3000   # 附带 Web UI（或 npm run web:dev 单独起 :5173）
npm run web:build      # 构建 Web → web/dist
npm test               # 全量单测（vitest）
```

- Node >= 22；`--dir` 默认 `./ai_default_project`；`--data-dir` 数据目录（会话/记忆/审计/应用/进化）
- 示例应用包：`examples/`（番茄钟 webapp / 批量替换 tool / 待办 service）——`/app install examples/<name>`；分发 `/pkg export app <id>` 后 `/install <file>.aw`

---

## 十三、目录结构

```
src/          核心（core 内核 / tools 工具 / mcp / agents 智能体 / memory 记忆 /
              security 安全 / terminal TUI / media 媒体 / commands CLI / server HTTP /
              hooks 扩展点 / evolution 进化）
web/          Svelte 5 前端（components / lib/stores）
config/       agents YAML / models / permissions / sandbox / plugins / mcp
data/         运行时数据（sessions.db / audit.db / apps / docs / evolution / media）
skills/       技能库（SKILL.md）
examples/     .aw 可分发示例应用包
docs/         本文档 + 竞品对比报告 + 截图/演示
plans/        路线图与进行中设计（历史计划见 sprint-history.md）
```

---

## 十四、版本演进

Phase 1~2（Sprint 1~12，0.1→0.3）：Agent 循环、Skills、7 专家、记忆、MCP、TUI/CLI、Team 协调器、API Server。
Web 时代（Sprint 13~22）：Web UI 设计与重构（Svelte 5）、TUI 引擎重写、HTTP/Web 对齐、权限确认通道、文件 Diff。
内核改造（Sprint 23~28）：LLM seam、事件溯源、轨迹观测、DSH 对标两批、插件契约 + scoped 工具、执行沙箱 + WebSocket + CI。
工程纵深（Sprint 29~33）：迭代预算、调度/后台任务/引导、`.aw` 导入导出、diff 提速 + terminal_exec、高危拦截修复。
AI OS（Sprint 34~42，0.7→1.0）：应用模型 + 进程模型、AppFactory 即时生成、语音/视频、Web 技能模式、文档预览、进化引擎三期（观察提议 / 补丁回滚 / 评测验证）、1.0 整合 + 每会话项目目录。
可信与体验（Sprint 43~49）：离线 ASR/TTS、Token 统计口径、TUI 块式视图、可信基线（CI/Web 静态检查/权限规则化/Windows 沙箱）、headless + 检查点回滚、权限路径策略单点。
并行纵深（Sprint 52，1.9）：后台子智能体（可续接 / 可控制 / 可观测 / 不降级安全 / 可撤销）。

逐 Sprint 明细见 [plans/sprint-history.md](../plans/sprint-history.md)；后续方向见 [plans/roadmap-next.md](../plans/roadmap-next.md) 与 `docs/主流Agent产品对比分析报告.md`。
