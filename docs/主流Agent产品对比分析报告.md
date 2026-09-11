# AiWorker 项目审视与主流 Agent 产品对比分析报告

> **报告日期**：2026-09-10
> **审视对象**：AiWorker `1.4.0`（commit `8dad3aa`，分支 `dev`，Sprint 1–46）
> **对比对象**：Claude Code（Anthropic）· OpenAI Codex · DeepSeek Harness（DeepSeek）· 千问办公 QwenWork（阿里）· WorkBuddy（腾讯）· 豆包工作 / 扣子 Coze（字节）· 对照：Manus、WPS 灵犀
> **方法**：AiWorker 侧基于仓库源码逐模块审读与量化统计（非文档转述）；竞品侧基于官方文档、官方定价页、一手报道与实测（DSH 为本机安装实现只读检查），逐条标注来源与信息时点。
> **口径说明**：竞品数据多为 2026-08～09 的快照，价格与版本会快速变动；未经官方确认的数字已标注来源口径。

---

## 摘要（TL;DR）

1. **AiWorker 与上述竞品都不是同一物种**：它是「本地优先的个人 AI OS」——终端 TUI 与本地 Web 双界面、7 专家角色化多智能体、三层记忆、应用即时生成、纯自研零框架。它既不是 Claude Code/Codex 那样的**专业编码 Agent**，也不是千问办公/WorkBuddy/豆包工作那样的**企业办公交付平台**，更不是 DSH 那样的**可插拔 Agent 运行时平台**。
2. **做得好的**（相对同类个人助手）：自研闭环与极低依赖（9 个运行时依赖）、TUI 打磨深度（帧缓冲/CJK/OSC 8/块式回合）、角色化多智能体 + 零成本模板计划、事件溯源会话 + 三层记忆 + 上下文工程、安全默认 fail-closed、**自进化 Skills**（竞品均无沉淀闭环）、应用即时生成、中文与离线本地化（ASR/TTS）、工程质量纪律（0 `any`/0 TODO、824 测试全绿）。
3. **主要不足**：① 无进程级沙箱（安全纵深最大差距）；② 无 headless/SDK，无法被 CI 或其它程序编排；③ 无插件市场、无 CI/容器/发布流水线；④ 无多端与云沙箱；⑤ 并行与长程能力弱（3 并发 / 8 步，无 continuable 子智能体、无 goal/Ralph 循环）；⑥ 工具面窄（9 个内置，无 LSP/浏览器/Notebook）；⑦ **Office 交付弱**（只能读不能写，办公场景的入场券缺失）；⑧ 无检查点/对话回滚；⑨ 成本与压缩策略单一。
4. **最该做的四件事（P0）**：CI 门禁 + Web 静态检查；权限规则化（`Tool(specifier)` deny→ask→allow + 永不自动批准清单）+ Windows 最小沙箱；headless `-p`（JSON/stream-json）+ SDK 雏形；检查点与"回滚到某轮"（代码+对话）。
5. **战略建议**：**不要正面硬刚** Claude Code 的编码主战场与国产办公的生态战；把差异化钉在「数据不出本机 + 中文/离线 + 可读可控的单体架构 + TUI 深度 + 应用即时生成」上，先补齐"可信赖底线"（沙箱/权限/CI/可编排），再补"长程可靠性"（子智能体/目标/检查点），最后才是办公交付与多端。

---

## 一、方法与范围

| 项目 | 说明 |
|---|---|
| 代码审读 | 审读时点（commit `8dad3aa`）：`src/` 117 个 TS 文件（23,680 行）、`web/src/` 45 个文件（10,004 行）、`test/` 58 个文件（12,625 行）；1.5.0 收尾时为 `src/` 117 文件（24,075 行）、`test/` 59 文件（13,116 行） |
| 量化统计 | 87 个 REST 端点、9 个内置工具、7 个专家 YAML、44 个 `SKILL.md`、2 个示例插件、33 个 Web 组件、27 个 CHANGELOG 版本 |
| 验证基线 | `tsc` ✓、`eslint src/` ✓、`vitest` 824/824 ✓、`vite build` ✓（审读时点实测；1.5.0 收尾为 **862/862**、`svelte-check` 0 错、`npm run verify` exit 0） |
| 资料边界 | 未做竞品账号实测（除 DSH 本机实现）；不采信无来源的营销数字 |

---

## 二、AiWorker 全景盘点

**一句话定位**：跑在个人电脑上的「本地 AI OS」——终端 TUI + 本地 Web 双界面，7 专家角色路由 + DAG/辩论协作 + 工具/MCP/Skills/Hooks/插件 + 三层记忆 + 应用即时生成，纯自研、低依赖、中文优先。

### 2.1 形态与技术栈

| 维度 | 现状 |
|---|---|
| 语言/运行时 | TypeScript 严格模式（`strict: true`）、Node >= 22、ESM |
| 运行时依赖 | 仅 9 个（better-sqlite3、chalk、commander、cron-parser、inquirer、openai、sherpa-onnx-node、ws、yaml）——**无任何 Agent 框架** |
| 界面 | ① 自研 TUI（帧缓冲差分渲染、CJK 宽字符、OSC 8 超链接、块式回合视图）；② Web（Svelte 5 runes + Vite，33 组件，SSE + WebSocket 双通道） |
| 后端 | 单进程单体：`core/`（agent-loop、model-router、context-manager、team-coordinator、app-factory、event-bus、tool-registry）+ `agents/` + `tools/` + `mcp/` + `memory/` + `hooks/` + `security/` + `terminal/` + `server.ts` |
| 存储 | SQLite（WAL）+ FTS5，事件溯源 `session_events` 仅追加；`data/snapshots` diff 快照 |
| 分发 | 单 npm 包 `bin: aiworker`；无 Docker / 无 CI / 无市场 |

### 2.2 能力面清单

- **多智能体**：7 个内置专家（coding / research / data-analysis / financial / game-dev / product-ops / default，TS 默认 + YAML 覆盖）；正则加权路由 + LLM 语义兜底；`/plan` DAG 协作（4 套模板 + Kahn 环检测 + 关键/非关键步骤 + 失败容忍）；`/debate` 双专家互审 + 综合报告。
- **Agent Loop**：同步/流式双实现；`MAX_ITER` 默认 50；空响应 3 次断路器；上下文 75% 阈值压缩 + 前缀冻结快照；工具调用统一超时；工具失败可回灌模型续跑。
- **记忆三层**：工作记忆（会话内）、情景记忆（FTS5 + `Intl.Segmenter` 中文分词 + 三阶段检索 + 0.15/日时间衰减，下限 0.1）、语义记忆（`MEMORY.md` / `USER.md` 有界管理）。
- **工具**：9 个内置（fs_read / fs_write / fs_edit / list_dir、terminal_exec、terminal_session 持久终端池、web_search、web_fetch、ask_user）+ MCP 工具（`mcp_{server}_{tool}`）。
- **扩展**：MCP（stdio/HTTP、内置 4 工具服务器、健康检查 + 指数退避重连）；Skills（44 个 `SKILL.md` 递归加载 + 正则触发 + **自进化**：迭代≥3 且工具≥3 → Jaccard>0.5 去重 → 评分注册，默认 pending）；Hooks（`config/hooks.json`）；轻量插件（`config/plugins/<name>/` 默认导出 `setup(ctx)`）。
- **权限与安全**：`ask` / `plan` / `auto` 三模式；确认通道 fail-closed（CLI stdin / HTTP SSE 确认卡，30s 超时即拒）；路径遍历防护（`path.relative` 校验）；危险命令检测（`danger-detector`）；沙箱策略文件 `config/sandbox.json`；工具白名单按智能体过滤（`strictTools`）；审计（TurnLog / ToolCallLog / `file:preview` / 进化台账）。
- **AI OS 应用**：即时生成应用（webapp / tool / service 三类）+ `.aw` 资产包导入导出 + 沙箱 iframe 能力桥（**能力强制层：无 terminal**）+ 3 个示例应用。
- **自动化与本地化**：后台 job、自然语言 cron 调度、进化引擎（observe → propose → verify → rollback + 回归阈值 0.5 + 每日提案限频）、离线 ASR（sherpa-onnx paraformer-zh，232MB）/ TTS（vits-zh-ll，118MB）、模型一键下载（hf-mirror）。
- **模型接入**：多 profile（`config/models.json`，`${ENV}` 引用）；DeepSeek 思考模式（`extra_body`，thinking 时禁 temperature）；本地 lite 模型；`getDisplayModel()` 呈现生效 profile。

### 2.3 工程与质量信号

| 指标 | 数值 | 说明 |
|---|---|---|
| 代码量 | 23.7k（src）+ 10.0k（web）+ 12.6k（test） | 单人可完整理解 |
| 测试 | 57 文件 / 824 用例，全绿 | 含端点、WS、TUI 渲染、会话事件、进化引擎、应用生命周期 |
| 静态质量 | `TODO/FIXME` 0、`as any`/`: any` 0、`@ts-ignore` 0、`eslint-disable` 12 | 严格 TS 无逃逸 |
| 文档 | `docs/` 4 篇 + `plans/` 46 份 Sprint 计划 | 设计-实现可追溯 |
| 版本节奏 | 27 个版本（0.1.0 → 1.4.0），CHANGELOG 日期集中在 2026-08-15～09-10 | 迭代极快，实测驱动修补（45.1/45.2/45.3） |
| 工程化缺口 | 无 `.github/`、无 Dockerfile、无 coverage、lint 仅覆盖 `src/`、Web 无 svelte-check | 见第四章 |

---

## 三、AiWorker 做得好的地方

1. **端到端自研闭环，零框架依赖**：从 agent-loop、上下文压缩、TUI 帧缓冲到 Web UI 全部自己实现，9 个运行时依赖且无 Agent 框架。代价是重复造轮子，收益是**完全可控、可离线、可单文件读懂**——这在同类产品普遍依赖 LangChain/Cordis 等框架的背景下是稀缺属性。
2. **双界面体验打磨到位**：TUI 做到帧缓冲差分渲染 + CJK 宽字符对齐 + OSC 8 超链接 + 块式回合视图（思考/工具/回答可折叠、流式摘要、焦点导航）；Web 做到 SSE 流式 + WS 事件总线双通道、33 个组件覆盖系统/技能/应用/文档/设备/审计面板。同类开源个人 Agent 极少同时把两个界面都做到这个完成度。
3. **多智能体"角色化"路线务实**：7 专家 + 模板化 DAG 计划（**零 LLM 成本**）+ 双专家辩论，开箱即用；相比"给模型一套编排原语、让它自己组合"的路线，角色化对个人日常任务（写代码/查资料/理财/做游戏）命中率更高、更省 token。
4. **记忆与上下文工程扎实**：事件溯源会话（仅追加）+ SQLite WAL + FTS5 中文分词 + 时间衰减三层记忆 + 前缀冻结快照压缩 + 分层 token 计量（`/context` 占比、会话/本轮/全局三档），机制完备度超过多数同类个人助手。
5. **安全默认保守**：确认通道 fail-closed（无回答者即拒绝、30s 超时即拒）、危险命令拦截、路径遍历防护、应用能力强制层（无 terminal）、全量审计。**"无确认通道 fail-closed"这条底线，很多更成熟产品反而做得更松。**
6. **自进化 Skills 是差异化**：迭代次数 + 工具调用数达标 → Jaccard 去重 → 评分注册（默认 pending 待确认）。DSH 与 Claude Code 的 Skills 都只有"加载"，没有"沉淀"闭环。
7. **应用即时生成（AI OS 方向）**：把"生成一个能跑的小应用"产品化（webapp/tool/service + `.aw` 包 + 能力桥 + 能力强制层），并有 3 个示例应用与 9 个端到端测试族。这是通用编码 Agent 不会覆盖的形态。
8. **本地化与中文优先**：全中文交互、中文分词检索、离线 ASR/TTS（不依赖云、可离线）、hf-mirror 一键下载、Windows 优先适配（PowerShell 约束、CRLF、路径分隔符）。对中文个人用户的实际可用性优于英文优先产品的原版。
9. **工程质量纪律**：严格 TS 下 `any`/`ts-ignore`/TODO 全为 0，824 用例全绿，工具产物预览这类新功能带 7 个专项测试；`docs/` + `plans/` 让设计意图可追溯（本次审查能快速定位问题，正是受益于此）。
10. **版本与迭代速度**：三周多时间 27 个版本、46 份 Sprint 计划，且每个 Sprint 都有明确验收；实测反馈当天修补（45.1→45.3）。个人项目里罕见的产品化节奏感。

---

## 四、AiWorker 的不足

> 按"影响面 × 修复成本"排序，标注严重度（P0 阻塞差异化 / P1 明显落后 / P2 长期项）。

### 4.1 安全与权限（最大差距）

| # | 不足 | 现状证据 | 对比对象 | 严重度 |
|---|---|---|---|---|
| 1 | **无进程级沙箱** | 仅 `path.relative` 路径校验 + 危险命令正则 + `sandbox.json` 策略；`terminal_exec` 与真实 shell 同权限 | Claude Code：macOS Seatbelt / Linux bubblewrap + seccomp + 文件系统 allow/deny + 网络域名白名单；DSH：bwrap / landlock / Seatbelt / Windows ACL 受限令牌，fail-closed 探测 | **P0** |
| 2 | 权限规则粒度粗 | 三模式 + 工具白名单；无 `Tool(specifier)` 级 deny→ask→allow 求值、无"永不自动批准"清单、无网络域白名单 | Claude Code 的 deny/ask/allow 首命中求值 + 受保护路径 + critical path `rm` 永不自动批 | P1 |
| 3 | 审批无记忆、无 allow-always | 每次都要确认（或整档 auto 全放开） | DSH 也只有 ask/never（同为短板）；Claude Code 有会话级规则与 settings | P2 |

### 4.2 平台化与生态

| # | 不足 | 现状证据 | 对比对象 | 严重度 |
|---|---|---|---|---|
| 4 | **无 headless / SDK，无法被编排** | 仅有 CLI 交互与 HTTP 端点；无 `-p` JSON 输出、无 Python/TS SDK | Claude Code：`claude -p`（json/stream-json/json-schema，10MB stdin）+ Python/TS Agent SDK；DSH：headless / sdk-app / acp-app profile | **P0** |
| 5 | 无插件生态与市场 | 插件机制仅 2 个本地示例，无版本/依赖/市场，无作用域遮蔽 | Claude Code 官方 + 社区 marketplace、`/plugin install`；DSH 152 条插件组合、hot-reload；千问办公/WorkBuddy 各有技能市场与 100+ 伙伴 | P1 |
| 6 | 无 CI / 无容器 / 无发布流水线 | 仓库无 `.github/`、无 Dockerfile、无 coverage；`lint` 仅 `src/` | 主流产品均为 CI 门禁 + 容器镜像 + 版本发布 | P1 |
| 7 | 前端无静态检查与组件测试 | 无 svelte-check，无 Web 测试；主 chunk 1.43MB（gzip 430KB）+ xlsx 独立 429KB | 成熟前端工程标配 | P2 |
| 8 | 无多端（移动/桌面壳/云） | 仅本机 TUI + localhost Web；无移动端、无云沙箱、无托管任务 | Claude Code：Web/iOS/Android/Desktop/Slack/GitHub Actions + 云沙箱 + 自建算力；豆包工作：云电脑持续执行 + 手机远程查看；Manus：任务级隔离云 VM | P1（架构性，长期） |

### 4.3 Agent 能力纵深

| # | 不足 | 现状证据 | 对比对象 | 严重度 |
|---|---|---|---|---|
| 9 | 并行与长程能力弱 | 协作 `MAX_STEPS=8`、`MAX_PARALLEL=3`；无 continuable 子智能体、无后台 agent 控制（发消息/中断/列举）、无 fresh-agent 循环、无目标驱动 | Claude Code：20 并发子智能体、嵌套 3 层、agent view、workflow 1000 agent/16 并发、`/goal`、`/loop`；DSH：subagent/fork/control + workflow worker-thread + ralph + goal 轮次驱动 | **P0** |
| 10 | 工具面偏窄 | 9 个内置工具；无 LSP、无浏览器/电脑操作、无 Notebook、无图像理解工具、MCP 仅桥接 tools（无 resources/prompts） | Claude Code 30+ 工具（含 LSP、Notebook、Worktree、Cron、Task 族）；豆包工作可操作浏览器与电脑；DSH 有 web_search/fetch + 代码运行时 | P1 |
| 11 | **交付物生成能力弱** | Office 仅"预览"（docx/xlsx 只读转换，pptx 仅下载兜底）；无 PPTX/Word/Excel **写出**、无数据分析可视化产出 | 千问办公/WorkBuddy/豆包工作均以 PPTX/Word/Excel/HTML 交付为核心卖点；WPS 灵犀直接在文档内作业 | P1（若要面向办公场景，需升级为 P0） |
| 12 | 无检查点与对话回滚 | 有 diff 快照审计，但不能"回滚到某轮（代码+对话）" | Claude Code：每 prompt 建检查点、保留 100 个、`/rewind` 四种恢复模式 | P1 |
| 13 | 会话/协作数据模型不完整 | `/plan`、`/debate` 无单一后端计划会话（刷新靠 localStorage）；协作步骤会话靠 `wk-` 前缀隐藏（本次修复）而非一等公民；无共享任务列表/会话间消息 | Claude Code agent teams（共享任务列表 + 会话间消息）；DSH goal 事件溯源 | P2 |
| 14 | 压缩与成本策略单一 | 单 75% 阈值 + 冻结快照；无 microcompact、阈值不可调、无缓存 TTL 优化；成本估算已移除（无 per-tool token 归因） | Claude Code：自动压缩阈值可调（100K–1M）、`/compact [焦点]`、1M 原生窗口；DSH：token-meter 驱动 + 工具结果剪枝 overlay | P2 |

### 4.4 产品与商业

| # | 不足 | 说明 | 严重度 |
|---|---|---|---|
| 15 | 会话界面功能薄 | 会话列表 50 上限（本次加了 `?limit` 参数）、无搜索/分组/标签/归档；无跨设备同步 | P2 |
| 16 | 无 i18n、无遥测/可观测导出 | 中文单语；审计是本地表，无 OTel/指标导出，难以复盘线上失败 | P2 |
| 17 | 无商业化与企业特性 | 无订阅/席位/SSO/权限管控/合规导出；对比国产品牌 60–999 元定价体系与 100+ 伙伴生态 | P2（个人项目可接受） |
| 18 | 品牌与文档表达 | `package.json` 的 `description` 字段是历史乱码（本次审查发现，未改）；README 无 Roadmap/贡献指南 | P2 |

---

## 五、竞品逐家分析

### 5.1 Claude Code（Anthropic）— 行业完成度标杆

**定位**：同一引擎多端交付的专业编码 Agent（v2.1.267，2026-09-09）：终端 CLI 功能最全，另有 Desktop（含 Linux beta/WSL2）、Web（claude.ai/code，research preview）、iOS/Android、VS Code/JetBrains、Chrome 扩展、Slack；企业可自建算力（self-hosted environments）。

**关键能力**：Opus 5 / Sonnet 5 / Fable 5.1 / Haiku 模型族 + `opusplan`（计划用 Opus、执行用 Sonnet）+ fast mode；子智能体默认后台、**20 并发、嵌套 3 层**，`.claude/agents/*.md` 可配工具/模型/`permissionMode`/`maxTurns`/`isolation: worktree`；agent view 一屏调度多会话；agent teams（实验）；dynamic workflows（JS 编排，**16 并发 / 1000 agent**、可断点续跑）；plan mode、`/goal`、`/loop`、`/subtask`；检查点每 prompt 一次、保留 100 个、`/rewind` 可选"代码+对话/只对话/只代码/向后总结"；CLAUDE.md 四级层级 + `@import`（4 跳）+ `.claude/rules/*.md` 路径级规则 + auto memory（`MEMORY.md` 仅载前 200 行/25KB，按 git 仓库共享）；上下文 Sonnet 5 原生 1M、约 967K 触发自动压缩（可调 100K–1M）。

**扩展与权限**：MCP（stdio/HTTP/SSE，工具延迟定义）；Skills 遵循开放 Agent Skills 标准（`context: fork`、动态上下文注入、`allowed-tools` 预授权），自定义 slash commands 已并入 skills；Hooks 覆盖 10+ 生命周期；**官方 + 社区插件市场**（`/plugin install x@marketplace`，插件可含 skills/agents/hooks/MCP/LSP/主题/输出样式）；`claude -p` headless（json/stream-json/json-schema）+ Python/TS Agent SDK；权限 deny→ask→allow 首命中求值 + 6 种模式（Pro/Max/Team 默认 `auto` 分类器）；沙箱 macOS Seatbelt / Linux bubblewrap + seccomp，文件系统与网络域双向白名单，企业可 `failIfUnavailable`。

**价格**：Free 无 Code 权限；Pro $20；Max 5x $100 / 20x $200；Team $100/席；Enterprise 定制。API：Sonnet 5 $2/$10、Opus 5 $5/$25 每 MTok；fast mode $10/$50（不计订阅额度）。官方企业成本参考：人均约 $13/活跃日、$150–250/月。

**已知短板（官方文档自述 + 社区）**：**原生 Windows 不支持沙箱（须 WSL2）**；检查点不追踪 bash 命令改动与子智能体编辑、不恢复链接、快照 30 天清理；自动压缩可能 thrashing；CLAUDE.md 属建议非强制；agent teams 计划模式约 7× token；成本事故被广泛报道（Uber 人均月费 $500–2000、`/loop` 整夜 $6000，均为二手来源）；GitHub issue 反映 1M 上下文实际约 200K 触发压缩（已关闭，未见关联修复条目）。

**对 AiWorker 的启示**：可抄的是**能力组织方式**而非体量——检查点/rewind、headless `-p` + SDK、权限规则求值、插件市场契约、子智能体并发与 agent view。字节与 Anthropic 都证明了"多会话调度台"是真实需求，而 AiWorker 目前一次只能跑一条协作链。

### 5.2 OpenAI Codex（OpenAI）— 编码 Agent 的"本地 + 云端"双形态

> **来源说明**：本节事实以本次会话可直接核实的**官方材料**为骨架——`openai/codex` 仓库 README（Apache-2.0、Rust 双平台安装器、`codex app` 桌面端、Codex Web 云形态、ChatGPT 套餐登录）与仓库 `docs/config.md`（`config.toml` / `requirements.toml` / 托管 hooks `allow_managed_hooks_only`）。标注 **※** 的条目为业界广泛引用的公开设计（沙箱三态、审批策略、AGENTS.md、云并行任务、模型族、额度体系），但 `developers.openai.com` 官方文档页在本环境返回 **HTTP 403**，**未能在本次会话独立核实**，引用时请以官方文档为准。

**定位与形态**：OpenAI 官方编码 Agent，同一品牌覆盖三种形态——① **本地 CLI**（Rust 单二进制；`curl install.sh | sh` / PowerShell 安装器 / `npm i -g @openai/codex` / `brew install --cask codex`，下载源默认 `releases.openai.com/codex` 并回退 GitHub Releases）；② **IDE 扩展**（VS Code / Cursor / Windsurf）与**桌面应用**（`codex app`，chatgpt.com/codex?app-landing-page）；③ **Codex Web 云端 Agent**（chatgpt.com/codex）。仓库 Apache-2.0 开源，与 Claude Code 的专有路线形成对照。

**模型**：GPT-5-Codex 系列 Codex 专用模型 + 推理档位（reasoning effort）可选 ※；模型仅限 OpenAI 系（与 DSH 的模型中立形成鲜明对比）。

**智能体能力**：**云端并行任务**（多任务同时执行、与 GitHub PR 流程结合的自动化）※；本地会话 `resume`、上下文自动压缩、`/review` 代码审查 ※；子代理/多代理编排能力弱于 Claude Code 与 DSH ※。

**上下文与记忆**：**AGENTS.md** 项目约定文件（多级目录约定；该模式已被 DeepSeek Harness 等广泛沿用）※；本地 `config.toml` 与管理员 `requirements.toml` 双层配置（后者可强制 `allow_managed_hooks_only`，忽略用户/项目/session 级 hook 配置——**此项已由官方 `docs/config.md` 核实**），支持生命周期 hooks（PreToolUse 等）※。

**扩展与集成**：MCP 支持 ※；`codex exec` 非交互执行（headless 雏形）※；SDK 与 IDE 集成 ※。

**权限与沙箱**：三态沙箱 **read-only / workspace-write / danger-full-access**，审批策略 **untrusted / on-failure / on-request / never**，网络访问默认关闭可按需开启 ※。这套命名在 2026 年事实上成了行业事实标准——**DSH 的沙箱三态与之一致，本次会话（DeepSeek Harness）即运行在 `danger-full-access`**，可见其设计影响力。

**价格与额度**：可用 **ChatGPT Plus / Pro / Business / Edu / Enterprise** 套餐额度（README 明确建议"Sign in with ChatGPT"），也可用 API key 走 API 计费 ※；额度随套餐档位与周窗口限制 ※。相比 Claude Code 的 $20/$100/$200 订阅与 API 双轨，Codex 更强调"已订阅 ChatGPT 即可用"的转化路径。

**对 AiWorker 的启示**：
1. **沙箱三态与审批命名值得直接对齐**（read-only / workspace-write / danger-full-access + untrusted/on-failure/on-request/never），这样用户与其他 Agent 产品的肌肉记忆可迁移——AiWorker 目前是 ask/plan/auto 三档，语义不直观且缺"按次审批 vs 失败才问"的中间态。
2. **AGENTS.md 已成为跨产品约定**（Codex、DSH、Cursor 等均支持）；AiWorker 已有 `AGENTS.md`，但仅作为开发规范文件，**未把它接入上下文注入**——低成本高收益的补齐点。
3. **"本地 CLI + 云 Web 同品牌"**说明单一形态难以覆盖全部场景；AiWorker 只做本地，短期无碍，但云端"异步长任务"是明确的长期缺口。

### 5.3 DeepSeek Harness（DeepSeek）— 插件化运行时平台

**定位**：2026-08-13 发布的 MIT 开源 Agent 运行时（本机实测 `@deepseek-ai/dsh@0.1.5-rc.1`，内嵌 239 个子包，web profile 组合出 **152 条插件**），Cordis 插件内核，官方等式「Model + Harness = Agent」。

**关键能力**：profile = 有序 bundle patch 层 + 用户 patch + `--patch`，`patchReload: live` 热重载；会话 JSONL 持久化 + SQLite 查询 + 投影缓存 + checkpoint policy；`goal` + 轮次驱动；`subagent` / `fork` / `subagent-control`（`send_message` / `interrupt_agent` / `list_agents`）；`workflow`（worker-thread 跑 JS 编排）+ `ralph`（fresh-agent 循环）+ `todo` + `plan-mode`；`jobs` 后台任务；skills 四级扫描根 + Chokidar 热发现；沙箱三态 **read-only（默认）/ workspace-write / danger-full-access**，审批 `ask`/`never`，无 answerer 即 fail-closed（**仅单次授权、无 allow-always**）；模型真正中立（DeepSeek 官方 + 任意 OpenAI 兼容端点，本机已接入 `localhost:8000/v1`）。

**已知短板**：开发者预览期，README 全大写警告破坏性变更；**无内置 TUI**（`dsh-terminal` 是持久终端服务，默认界面是本地 Web GUI，终端 UI 靠第三方）；MCP 与调度**不在默认 profile**，需手动 overlay，MCP 仅桥接 tools；审批只有两态，实践中易滑向全放开（本机即为 danger-full-access + 审批禁用）；无官方插件市场与 Docker 镜像。

**对 AiWorker 的启示**：这是与 AiWorker **同场景、不同哲学**的最近对手——DSH 用"一切皆插件 + 能力缝"换生态纵深，AiWorker 用"自研紧凑单体"换可读与开箱即用。DSH 的 `subagent-control`/`goal`/`workflow`/`ralph` 四件套正是 AiWorker 第 9 项短板的补齐方向；而 DSH 缺 TUI、缺审批记忆、缺市场，说明**它也不是完成态**——AiWorker 的 TUI 与自进化 Skills 仍是差异化资产。

### 5.4 千问办公 QwenWork（阿里）— 企业交付型 Agent 平台

**定位**：企业与专业个人的"交付型" AI Agent 平台（2026-08-03 公测；QoderWork + 悟空 + MuleRun 三线合一），网页 + PC 客户端 + 钉钉内嵌。官方战报（2026-09-04）：首月注册用户破 3000 万、企业用户过半。

**关键能力**：Qwen3.8 底座（与产品同日发布并首发接入）；**钉钉 25 项 IM 原子能力**（群聊、考勤、审批、会议日程、知识库、邮件）；产出 **PPTX / Word / Excel / HTML 并支持原生编辑**；多模态理解与生成；带数据库的免部署网页生成；接入 1688、小红书等数据源；技能市场 + 行业专家套件；定时任务。

**价格**：免费版 100 积分/日；个人标准 78 元/月、高级 158 元/月；**企业版 198 元/席/月**；阿里云 Token Plan 支持 22:00–08:00 错峰折扣。

**已知短板**：3000 万为注册口径，未披露日活/留存/付费；与千问 App 账号会员割裂（仅支持钉钉扫码）；"悟空"线被内外视为半成品；组织上产品归钉钉、销售归阿里云。

**对 AiWorker 的启示**：办公交付（Excel/PPT 写出 + 钉钉级上下文继承）是其真正护城河，而这恰是 AiWorker 第 11 项缺口。若 AiWorker 想进办公场景，最小切入不是做 IM 集成，而是**Office 写出 + 本地文档/表格理解**。

### 5.5 WorkBuddy（腾讯）— 桌面优先的通用办公智能体

**定位**：腾讯云 CodeBuddy 团队孵化，2026-03-09 公测；Win/Mac 桌面端为主（另有 IDE、插件、CLI、小程序、移动端），可接入微信/企微/QQ/飞书/钉钉机器人。

**关键能力**：模型多源内置（混元 Hy4/Hy3、GLM-5.x、MiniMax-M3、Kimi-K3、DeepSeek-V4 等）+ 三档模型模式（快速/均衡/极致）+ 自定义模型（本地 `models.json`）+ Ollama 本地部署；文档/表格/数据分析/可视化、多 Agent 协作、技能市场、连接器、自动化、资料库、腾讯文档与 ima 知识库、记忆、安全沙箱。2026-09-02 开放平台接入 100+ 软硬件伙伴。

**价格**：体验版免费（500 积分/月）；标准 99 元/月、高级 199、旗舰 999；企业旗舰 198 元/人/月、专享 316 元/人/月。

**已知短板**：实测新模型速度约为同行 1/4–1/3；长程任务（>20 步或 >1 小时）成功率偏低；2026-07-01 涨价（三家中唯一逆势提价）；上下文靠"连接"企微/腾讯文档而非权限原生继承。数据口径争议（易观"PC 端第一/DAU 百万" vs QuestMobile 7 月 PC MAU 658 万），腾讯未官方公布。

**对 AiWorker 的启示**：它与 AiWorker 的定位最接近（个人桌面 Agent + 多模型 + 本地模型 + 技能/连接器），差别在**沙箱、连接器生态与交付物**。它的"长程任务成功率低"也说明：**长程可靠性是全行业未解难题**，AiWorker 不必因为并发上限低而自卑，但必须把"单链可靠性 + 可中断可恢复"做扎实。

### 5.6 字节系：豆包工作 / 扣子 Coze / Trae（字节跳动）

**组织收拢**：2026-07-30 飞书产品团队并入豆包；08-24 TRAE 与扣子团队整体并入豆包体系（TRAE IDE 与 CLI 保留为编程产品线）。

**豆包工作**（2026-08-25 发布）：文档/表格/PPT、图片/视频/网页/应用生成 + 框选局部修改；**可操作浏览器与电脑、云电脑持续执行、手机远程查看推进**；200+ 技能与连接器；多 Agent"小队"协作；**与飞书深度整合——员工继承其在飞书中的全部权限**（对钉钉/企微只能逐次授权"调用"）。价格：个人连续包月 68 元、团队版 166 元/席/月（四家最低）。

**扣子 Coze**：2025-12 起「扣子开发平台」升级为「扣子编程」，转为基于 AI 编程的全代码应用开发平台；企业版可经火山方舟接 GPT-4o/Claude/DeepSeek。团队 198/398/1998 元，企业标准版 980 元/月起。"扣子空间 Coze Space"未能确认为现役独立产品（推断其能力已并入豆包工作/扣子编程）。

**Trae**：国内首款 AI 原生 IDE，2026 年由按次数改为**按 Token 计费**。

**对 AiWorker 的启示**：**"工作上下文的继承权"是 2026 年竞争焦点**（字节靠拆解飞书做继承，腾讯靠连接，阿里靠钉钉存量）。AiWorker 的对应物是**本地文件系统 + 会话工作目录 + 三层记忆**——天然拥有"全量上下文继承"，但没有协作层权限模型。个人场景下这反而是优势（无权限墙），企业场景是硬伤。

### 5.7 对照：Manus（通用云 Agent）

**定位**：云端通用 Agent（Butterfly Effect），每个任务分配**完全隔离的云虚拟机**（网络 + 持久文件系统 + 真实浏览器 + 代码执行），空闲沙箱 7/21 天回收；可并发 100+ 子代理；跨 100+ 来源深度研究、代码部署、数据分析、内容/幻灯片生成、表单与网页自动化。价格 $20/$40/$200 月 + 免费 300 积分/日。

**短板**：积分消耗不可预测、任务开始前无法估成本；数据全程在第三方云；异步执行而非交互式；2025-12 Meta 收购（2026-04 监管介入）前景未定，中国内地可及性受限。

**对 AiWorker 的启示**：Manus 证明"任务级隔离沙箱 + 长程自治"是天花板形态；AiWorker 的本地属性在**隐私与零成本**上有结构性优势，适合明确打出"数据不出本机"的差异化。

### 5.8 对照：WPS 灵犀（金山办公）— 文档内嵌智能体

**定位**：原生 Office 智能体，在文档内部作业（本地电脑模式 + 云端专家模式），非独立办公平台。2026-08 的 1.2.33 开放内置模型自选（Doubao-Seed-2.1 Pro、Qwen3.8-Max、DeepSeek V4 Pro），并标注灵点换算倍率。价格：体验版 800 灵点/月，标准 48 元、进阶 128、旗舰 398 元/月。

**短板**：与 WPS 大会员体系割裂（无赠送/折扣）引发老用户反弹；灵点消耗快于同类；复杂任务单次可达 3000 灵点。

**对 AiWorker 的启示**：形态差异最大——它证明"**在用户已有工作载体里干活**"比"再开一个平台"阻力小得多。AiWorker 的 Web/TUI 是独立载体，若做办公能力，优先考虑"就地处理本地文件"（打开即改、改完落盘）而不是自建编辑器。

## 六、对比矩阵

> 图例：**✅ 强 / ◇ 中 / △ 弱 / ✗ 缺**。这不是打分排名，而是**定位差异地图**——每个产品在自己赛道上的取舍不同。国产办公列合并千问办公 / WorkBuddy / 豆包工作；最后一列为形态对照（Manus / WPS 灵犀）。

| 维度 | **AiWorker** | Claude Code | OpenAI Codex | DeepSeek Harness | 千问办公·WorkBuddy·豆包工作 | Manus / WPS 灵犀 |
|---|---|---|---|---|---|---|
| 定位 | 本地个人 AI OS | 专业编码 Agent | 编码 Agent（本地+云） | 可插拔 Agent 运行时平台 | 企业办公交付平台 | 云通用 Agent / 文档内嵌 |
| 形态与入口 | TUI + 本地 Web | CLI/Desktop/Web/移动/IDE/Chrome/Slack | CLI/IDE/桌面/Web | 本地 Web GUI（无 TUI；另有 headless/SDK profile） | PC 客户端 + 网页 + 钉钉/飞书内嵌 | 云 SaaS + App / Office 内嵌 |
| 云端沙箱与多端 | ✗ | ✅（云 VM、self-hosted、WSL2） | ✅（Codex Web 并行云任务） | ◇（本地沙箱强，无云） | ✅（云电脑 + 手机远程） | ✅ |
| 模型自由度 | ✅（多 profile + 本地 lite + OpenAI 兼容） | ✗（Anthropic 系） | ✗（OpenAI 系） | ✅（DeepSeek + 任意 OpenAI 兼容） | ✅（多源内置可自选） | ◇ |
| 多智能体编排 | △（7 专家 + DAG 8 步/3 并发 + 辩论） | ✅（20 并发/3 层嵌套/agent view/workflow 1000 agent） | △（云并行任务为主） | ✅（subagent/fork/control + workflow + ralph + goal） | △（多 Agent"小队"，细节闭源） | ✅（Manus 100+ 子代理） |
| 长程与后台执行 | △（job/调度/进化；无后台子智能体） | ✅ | ✅（异步云任务） | ✅ | ◇ | ✅ |
| 工具面 | ✗（9 个内置；无 LSP/浏览器/Notebook） | ✅（30+，含 LSP/Notebook/Worktree/Cron） | △ | ◇（fs/shell/web/代码运行时 + MCP overlay） | ✅（Office 全家桶 + 浏览器/电脑操作 + 数据源） | ✅ |
| 上下文与记忆 | ✅（事件溯源 + 三层记忆 + FTS5 中文 + 冻结快照） | ✅（CLAUDE.md 四级 + auto memory + 1M 窗口） | ◇（AGENTS.md + 压缩） | ✅（JSONL + SQLite + 投影缓存） | ◇（企业知识库 + 权限继承） | ◇ |
| 扩展生态 | ✗（自研插件 2 示例、无市场、无 SDK） | ✅（MCP/Skills/Hooks + 官方&社区市场 + SDK） | ◇（MCP/hooks） | ✅（152 插件组合 + 热重载） | ✅（技能市场/200+ 连接器/开放平台 100+ 伙伴） | ◇ |
| 安全沙箱 | ✗（仅路径校验 + 命令正则） | ✅（Seatbelt/bwrap+seccomp；**原生 Win 不支持**） | ✅（三态沙箱） | ✅（bwrap/landlock/Seatbelt/Windows ACL，fail-closed） | ◇（宣称安全沙箱，未验证） | ✅（Manus 任务级 VM） |
| 审批粒度 | △（ask/plan/auto，fail-closed 30s） | ✅（deny→ask→allow + 6 模式 + 受保护路径） | ✅（untrusted/on-failure/on-request/never） | △（ask/never，无 allow-always） | ◇ | ◇ |
| 可观测与回滚 | △（审计 + diff 快照，无 rewind） | ✅（100 检查点 + /rewind + 遥测） | ◇ | ✅（回放 + OTel 插件） | ◇ | ◇ |
| 交付物能力 | ✗（Office 只读预览） | ◇（代码/Artifact） | ◇（代码/PR） | ✗（编码向） | ✅（PPTX/Word/Excel/HTML 原生编辑） | ◇ / ✅（灵犀文档内作业） |
| 中文与本地化 | ✅（中文优先 + 离线 ASR/TTS + Windows 适配） | △ | ◇ | △（有中文文档） | ✅（原生中文办公） | ◇ |
| 开源与许可 | ✅（Mulan PSL v2） | ✗（专有） | ✅（Apache-2.0，CLI 仓库） | ✅（MIT） | ✗（闭源 SaaS） | ✗ |
| 价格锚点 | 免费 + 自备 API key | Pro $20 / Max $100·$200 / Team $100·席；API $2–5/MTok | ChatGPT 套餐（Plus/Pro/Business/Edu/Enterprise）+ API | 免费开源 + 自备模型 | 免费档 + 个人 39.9–199 元 + 企业 166–316 元/席 | Manus $20–200；灵犀 48–398 元 |
| 成熟度 | 个人项目 1.4.0（无 CI） | 生产级 v2.1.267 | 生产级 | 开发者预览（官方明示破坏性变更） | 生产级（收费运营中） | 生产级 / 争议中 |

**读法**：AiWorker 在「中文与本地化、开源、上下文与记忆、模型自由度」上并不落后，甚至优于部分商业产品；差距集中在**安全沙箱、扩展生态、工具面、云与多端、长程并行、交付物**六项——这六项恰好也是"从个人玩具走向可信工具"的门槛。

---

## 七、结论与路线图建议

### 7.1 定位结论

| 对比对象 | 与 AiWorker 的关系 | 结论 |
|---|---|---|
| Claude Code | 不同物种（专业编码 Agent，多端 + 云 + 生态成熟） | 学习其**能力组织方式**（检查点、headless/SDK、权限求值、agent view、插件市场），不追其体量 |
| Codex | 不同物种（编码 + 云端并行任务） | 同上；其沙箱三态与 AGENTS.md 约定值得对齐 |
| DeepSeek Harness | **同场景、不同哲学**（插件化运行时 vs 紧凑单体） | 最值得逐项借鉴：subagent-control、goal 轮次、workflow、ralph、能力缝抽象 |
| 千问办公 / WorkBuddy / 豆包工作 | 不同物种（企业办公交付平台） | 若进办公场景，先做**交付物写出**（Office）与本地文件就地处理，而非生态扩张 |
| Manus / WPS 灵犀 | 形态两端（云 VM 自治 / 文档内嵌） | Manus 佐证"任务级隔离 + 长程自治"天花板；灵犀佐证"在用户已有载体里干活"阻力最小 |

**一句话**：AiWorker 的独特性不在"比别人功能多"，而在「**同一个进程里，中文个人用户能读懂、能离线、数据不出本机地拥有一个完整 Agent OS**」。这条路线在 2026 年的市场里没有被任何一家正面占据（DSH 是开发者运行时、Claude Code 是云+专有、国产品牌是企业办公）。

### 7.2 护城河（应当继续加强的既有优势）

1. **TUI 深度**：竞品里只有 Claude Code 的 CLI 达到同级别终端体验，DSH 甚至没有内置 TUI（第三方 `dsh-tui` 补位），国产品牌基本不做终端。这是低成本高辨识度的阵地。
2. **本地与离线**：离线 ASR/TTS + 本地模型（lite/Ollama）+ 数据全在本地 SQLite。可明确宣传「零云端依赖 / 数据不出本机」，对齐隐私敏感用户。
3. **自进化 Skills 闭环**：44 个 SKILL.md + 沉淀/去重/评分注册，竞品只有"加载"。这是可讲故事的差异化，但需要更好的可见性（进化前后对比、一键回滚、效果统计）。
4. **应用即时生成（AI OS）**：`.aw` 资产包 + 能力桥 + 能力强制层，是"Agent 产出可运行产物"的完整闭环，比"生成代码片段"更进一步。
5. **可读的单体架构**：23.7k 行 + 0 `any`，单人可完整理解——对"想改就改"的个人开发者是真实价值。

### 7.3 路线图（按投入产出排序）

> 执行状态与验收见 `plans/roadmap-next.md`：P0 中 CI 门禁、Web 静态检查、权限规则化、Windows 最小沙箱已于 **Sprint 47（1.5.0）** 落地，headless 与检查点/回滚排在 Sprint 48。

**P0 — 可信赖底线（建议 2–4 周，均可在现有架构内完成）**

| 项 | 内容 | 验收标准 |
|---|---|---|
| CI 门禁 | GitHub Actions：`build` → `lint` → `test` → `web:build`；附带 `svelte-check`（Web 首次纳入静态检查） | PR/push 自动跑，红灯阻断 |
| 权限规则化 | `config/permissions.json` 支持 `Tool(specifier)` 级 **deny → ask → allow** 首命中求值 + 通配（`mcp_*`）+ **永不自动批准清单**（ask_user、跨会话消息、受保护路径 `.git`/`.claude`/`.env` 等） | 单测覆盖求值顺序与通配；`/permissions` 可视化生效规则 |
| Windows 最小沙箱 | 至少做到：`terminal_exec` 子进程 cwd/环境白名单 + 允许写目录白名单 + 危险路径拒绝；有条件的受限令牌（Windows ACL restricted token）/ Job Object 超时回收 | 越界写被拒并审计；文档注明"非内核级隔离" |
| headless 模式 | `aiworker -p "<prompt>" --output-format json\|stream-json`，stdin 管道输入，退出码语义；复用现有 `/chat` 引擎 | 可在 CI 中用一行命令调起并解析结果 |
| 检查点与回滚 | 每轮用户输入前对工作目录做快照（复用既有 `data/snapshots` diff 引擎）+ `/rewind` 支持"代码+对话/只对话/只代码" | 至少覆盖 fs 工具改动；与既有 diff 面板打通 |

**P1 — 长程与工具纵深（建议 1–2 月）**

| 项 | 内容 |
|---|---|
| 后台子智能体 | 参考 DSH `subagent-control`：`spawn/fork` + `send_message` / `interrupt_agent` / `list_agents`，脱离"一次协作一条链" |
| 目标驱动 | `goal`（持久目标 + 轮次驱动 + 事件溯源），替代"一次性 `/plan`" |
| 工具面扩展 | LSP（本地 TS/Python）、浏览器/网页自动化、Notebook 编辑、图像理解（多模态模型能力已具备） |
| 权限记忆 | allow-always（会话级/项目级规则持久化）与一键撤销 |
| 会话体验 | 会话搜索/分组/归档、无 50 条上限、跨会话引用 |
| 压缩策略 | 阈值可调 + 工具结果剪枝 + 成本可见性（按 provider 单价本地估算，仅展示不做计费） |

**P2 — 场景扩张（季度级）**

| 项 | 内容 |
|---|---|
| Office 交付 | docx/xlsx/pptx **写出**（可复用已引入的 mammoth/SheetJS 反向能力或模板填充）+ 图表/表格生成 |
| 多端 | 移动端只读/远程推进（先做"手机看进度、批准危险操作"），桌面壳（Tauri 复用 Web UI） |
| 插件市场 | 插件契约升级（版本/依赖/能力声明）+ 官方目录 + `aiworker plugin install` |
| 观测与合规 | OTel/指标导出、审计导出（CSV/JSON）、团队共享记忆（可选加密同步） |
| i18n | 英文界面与文档（复用现有中文优先设计） |

### 7.4 明确不建议做的事

1. **不做通用编码 IDE 竞争**：Claude Code 有 20 并发子智能体 + 1M 上下文 + Seatbelt/bwrap 沙箱 + 官方市场，体量与生态不在一个量级；AiWorker 的编码能力应定位为"个人项目级助手"。
2. **不自建云沙箱/训练模型**：单位成本极高且与"本地优先"定位冲突；需要云端能力时优先接第三方 API 或用户自建端点（DSH 的模型中立路线可借鉴）。
3. **不追企业办公生态**：钉钉/飞书/企微级权限继承与 100+ 伙伴生态不是个人项目能打的；办公方向只做"本地文件就地处理 + 交付物写出"。
4. **不为并发而并发**：WorkBuddy 的实测教训是长程任务（>20 步）成功率普遍偏低；先把单链可靠性与可恢复性做扎实（检查点、审计、失败续跑），再谈并发上限。

### 7.5 一句话行动建议

**先补底线（CI / 权限 / 沙箱 / headless / 检查点），再补纵深（子智能体 / 目标 / 工具 / 交付物），始终守住"本地、离线、中文、可读"的定位——不要试图变成另一个 Claude Code，而要做别人不做的那一个。**

---

## 附录：主要来源

**AiWorker 自身**：仓库源码逐模块审读 + 量化统计（`src/` / `web/src/` / `test/` / `docs/` / `plans/`）；`CHANGELOG.md`（1.4.0，2026-09-10）；本次提交前实测 `tsc` / `eslint` / `vitest` 824 / `vite build` 全绿；既存 `docs/comparison-report.md`（DSH vs AiWorker 源码对比，Sprint 26 期）。

**Claude Code**（信息时点 2026-09-10，v2.1.267）：
[平台与集成](https://code.claude.com/docs/en/platforms)｜[Web 版](https://code.claude.com/docs/en/claude-code-on-the-web)｜[模型配置](https://code.claude.com/docs/en/model-config)｜[fast mode](https://code.claude.com/docs/en/fast-mode)｜[并行 agent](https://code.claude.com/docs/en/agents)｜[subagents](https://code.claude.com/docs/en/sub-agents)｜[agent view](https://code.claude.com/docs/en/agent-view)｜[workflows](https://code.claude.com/docs/en/workflows)｜[checkpointing](https://code.claude.com/docs/en/checkpointing)｜[记忆机制](https://code.claude.com/docs/en/memory)｜[skills](https://code.claude.com/docs/en/skills)｜[插件发现](https://code.claude.com/docs/en/discover-plugins)｜[headless/Agent SDK](https://code.claude.com/docs/en/headless)｜[工具参考](https://code.claude.com/docs/en/tools-reference)｜[权限](https://code.claude.com/docs/en/permissions)｜[权限模式](https://code.claude.com/docs/en/permission-modes)｜[沙箱](https://code.claude.com/docs/en/sandboxing)｜[成本](https://code.claude.com/docs/en/costs)｜[功能可用性矩阵](https://code.claude.com/docs/en/feature-availability)｜[v2.1.267 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.267)｜[CloudZero 定价综述](https://www.cloudzero.com/blog/claude-code-pricing/)｜社区 issues [#46998](https://github.com/anthropics/claude-code/issues/46998)、[#47049](https://github.com/anthropics/claude-code/issues/47049)、[#35296](https://github.com/anthropics/claude-code/issues/35296)、[#71618](https://github.com/anthropics/claude-code/issues/71618)

**OpenAI Codex**：官方仓库 README 与 `docs/config.md`（本次会话直接核实，Apache-2.0；[github.com/openai/codex](https://github.com/openai/codex)）｜[Codex 文档入口](https://developers.openai.com/codex)（本环境返回 403，未独立核实）｜[ChatGPT 套餐中的 Codex](https://help.openai.com/en/articles/11369540-codex-in-chatgpt)｜第三方速查：[codex-cheat-sheet](https://github.com/BA-CalderonMorales/codex-cheat-sheet)、[Codex 权限/沙箱/审批（中文）](https://www.w3cschool.cn/aicodingguide/codex-permissions.html)

**DeepSeek Harness**（本机 `@deepseek-ai/dsh@0.1.5-rc.1` 只读实测 + 公开资料，公开信息时点 2026-08～09）：[GitHub](https://github.com/deepseek-ai/deepseek-harness)｜[npm](https://www.npmjs.com/package/@deepseek-ai/dsh)｜[中关村在线报道](https://ai.zol.com.cn/1231/12318730.html)｜[Modellix 指南](https://www.modellix.ai/blog/deepseek-harness/)｜[Apidog 对比文](https://apidog.com/blog/deepseek-harness-vs-claude-code/)｜[InfoQ 报道](https://www.infoq.cn/article/de9AljWc4ejW2KAyW8dD)｜[DeepInfra 评测](https://deepinfra.com/blog/deepseek-harness-review)｜第三方 TUI [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)

**千问办公 QwenWork**：[官网定价](https://qwenwork.cn/pricing)｜[公测与定价（IT168）](https://m.it168.com/article_6944717.html)｜[首月战报（2026-09-04）](https://www.alibabanews.com/)｜[组织与质疑分析（界面，2026-09-04）](https://www.jiemian.com/article/15058040.html)｜[能力解析（阿里云社区）](https://developer.aliyun.com/article/1753347)

**WorkBuddy**：[个人版定价](https://www.workbuddy.cn/docs/workbuddy/Pricing)｜[企业版定价](https://www.workbuddy.cn/docs/enterprise/price/Pricing)｜[内置模型清单](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model)｜[开放平台与生态（2026-09-04）](https://www.sohu.com/a/1071898748_122014422)

**字节系（豆包工作 / 扣子 / Trae）**：[36氪整合报道（2026-08-24）](https://eu.36kr.com/zh/p/3953230805876099)｜[豆包工作发布实测（2026-08-25）](https://www.leikeji.com/article/78927)｜[扣子编程产品动态（官方）](https://docs.coze.cn/guides_release_note)｜[Coze 定价详解](https://micount.cn/tw/blog/coze-price.html)｜[Trae 按 Token 计费（IT之家）](https://m.ithome.com/html/923234.htm)

**对照产品**：[Manus 功能与定价解析](https://naoma.ai/zh-HK/articles/what-is-manus-ai)｜[WPS 灵犀收费价目表讨论](https://bbs.wps.cn/topic/93529)｜[灵犀专业版 1.2.33 更新说明](https://bbs.wps.cn/topic/94501)

**免责说明**：竞品信息均来自公开渠道，价格、版本、用户量会快速变化；未经官方确认的数字（如用户规模、参数规模、内部决策）已在正文标注口径。本报告不含任何竞品的非公开信息。

*报告生成：2026-09-10 · 基于 AiWorker 1.4.0（commit `8dad3aa`）*

---
