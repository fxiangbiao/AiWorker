# AiWorker → AI OS 架构规划

> 版本：v0.1（规划草案，待审核）
> 目标版本：0.7.0 → 1.0.0
> 一句话愿景：把 AiWorker 从"多智能体个人助手"升级为**个人 AI 操作系统**——AI 是大脑、Harness 是手脚、应用是进程、一切皆可即时生成、用完即毁。

---

## 一、愿景与三条铁律

### 1.1 愿景

```
┌──────────────────────────────────────────────────────────────┐
│                    AI OS（个人 AI 操作系统）                     │
│                                                              │
│   AI 是大脑   →  认知内核：路由 / 规划 / 记忆 / 决策 / 进化       │
│   Harness 是手脚 → 执行层：工具 / 终端 / 文件 / MCP / 应用进程     │
│   Plugin 是扩展 → 应用模型：五类应用、生命周期、即时生成、留存销毁   │
│   自进化      →  进化引擎：观察 → 提议 → 测试 → 推广/回滚          │
│                                                              │
│   三种交互：  语音/视频 · CLI/TUI · Web UI                      │
│   三类职能：  OS 管理 · 对话交互 · 任务执行与结果可视化            │
└──────────────────────────────────────────────────────────────┘
```

### 1.2 三条铁律（来自你的构想）

| # | 铁律 | 落地原则 |
|---|------|---------|
| 1 | **AI 是大脑，Harness 是手脚** | 认知内核只做决策，不直接碰文件/进程；一切执行走工具层，可审计、可拦截、可回滚 |
| 2 | **插件机制是扩展，支持自进化** | 统一为"应用模型"（App Model）；进化引擎能自己生成新应用/新工具并自我检验 |
| 3 | **应用可即时生成，用完可留存或销毁** | AppFactory 生成 → 校验 → 安装 → 运行 → 用户决定 keep/destroy；destroy 是干净移除（代码+进程+权限+审计） |

---

## 二、现状盘点：已有资产 → AI OS 映射

当前 AiWorker 已具备 AI OS 的大部分地基，差距主要在"应用生命周期"与"自进化闭环"。

| AI OS 能力 | 现状 | 差距 |
|-----------|------|------|
| 大脑（认知内核） | agent-loop / model-router / 7 专家路由 / team-coordinator / context-manager / 三层记忆 | ✅ 基本完备；缺"进程"抽象与统一资源预算视图 |
| 手脚（执行层） | 8 内置工具 / MCP / terminal / fs / 沙箱 / 权限三模式 | ✅ 完备；缺"应用沙箱目录"与"按应用授权" |
| 插件扩展 | plugin-manager（`setup(ctx)` 注册工具/Hook） | ⚠️ 只有"工具+Hook"一种形态，无生命周期、无 UI、无独立沙箱 |
| 自进化雏形 | skill-evolution（自动沉淀技能）+ 三层记忆 | ⚠️ 只进化"技能"，无系统级观察→提议→测试→推广闭环 |
| CLI 交互 | TUI 全命令系统（/plan /bg /schedule /install …） | ✅ 完备；补 /app /evo /os 命令 |
| UI 交互 | Web UI + SystemPanel 八 Tab + WS 实时 | ⚠️ 控制台缺"应用/进程/设备/进化"视图 |
| 语音/视频 | 无 | ❌ 全新建造（ASR/TTS/多模态输入） |
| 即时生成应用 | 无 | ❌ 全新建造（AppFactory） |
| 任务执行与可视化 | job-runner / scheduler / TracePanel / FileDiffPanel | ✅ 完备，融入 OS 进程视图即可 |
| IPC | event-bus（WS 广播）+ SSE | ⚠️ 广播够用；补"进程级事件"（app 生命周期等） |

**结论**：不是推倒重来，而是**在现有骨架上做三次抽象升级**：
1. 插件 → **应用**（生命周期 + 沙箱 + UI）
2. 会话运行 → **进程**（Agent 进程 / App 进程统一管理）
3. 技能进化 → **系统进化**（闭环 + 台账 + 回滚）

---

## 三、总体架构（分层）

```
┌──────────────────────────────────────────────────────────────────┐
│ ① 设备层 Devices                                                │
│    CLI/TUI（已有） · Web UI（已有） · 语音/视频（新增）             │
├──────────────────────────────────────────────────────────────────┤
│ ② 交互管线 Interaction                                           │
│    统一输入（文本/语音转文本/图片）→ 统一意图 → 统一输出事件流       │
├──────────────────────────────────────────────────────────────────┤
│ ③ 认知内核 Cognitive Kernel                                      │
│    agent-loop · model-router(多模态) · 7专家路由 · 规划 · 三层记忆  │
│    context-manager = 内存资源管理器（token 预算、上下文配额）       │
├──────────────────────────────────────────────────────────────────┤
│ ④ 进程层 Process Layer（新增）                                    │
│    process-manager：AgentProcess（会话运行）/ AppProcess（应用）    │
│    job-runner（后台任务）· scheduler（定时） 统一并入进程视图        │
├──────────────────────────────────────────────────────────────────┤
│ ⑤ 应用层 App Layer（新增/重构）                                    │
│    app-manager（生命周期状态机）· app-factory（即时生成）            │
│    应用沙箱 data/apps/<id>/ · 权限声明 · 五类应用                   │
├──────────────────────────────────────────────────────────────────┤
│ ⑥ 执行层 Execution                                               │
│    tools · MCP · terminal-session · fs（已有，全部保留）           │
├──────────────────────────────────────────────────────────────────┤
│ ⑦ 进化层 Evolution（新增）                                        │
│    observe(telemetry+记忆) → propose(meta-agent) → test(沙箱)     │
│    → promote/rollback（台账 + 快照回滚）                          │
├──────────────────────────────────────────────────────────────────┤
│ ⑧ 基础设施 Infrastructure                                        │
│    event-bus(IPC) · telemetry · audit 审计 · 权限/沙箱 · 版本       │
└──────────────────────────────────────────────────────────────────┘
```

**关键架构决策**：认知内核不直接感知"应用"，只通过工具/事件与进程层交互——应用就是一个"会自己干活、有生命周期、可被销毁"的工具集合。这让大脑保持简单，手脚无限扩展。

---

## 四、核心设计

### 4.1 应用模型（App Model）— 一切皆应用

现有 plugin-manager 只支持"注册工具 + Hook"一种形态。升级为**五类应用**，统一 manifest：

```jsonc
// data/apps/<id>/app.json
{
  "id": "pomodoro",
  "type": "app",                 // app | tool | skill | agent | service
  "name": "番茄钟",
  "version": "1.0.0",
  "description": "专注计时器，25 分钟工作 + 5 分钟休息",
  "entry": "index.js",           // 相对沙箱目录
  "permissions": ["fs:data/apps/pomodoro", "notify"],  // 声明式授权
  "lifecycle": { "onStart": "start()", "onStop": "stop()", "onDestroy": "cleanup()" },
  "ui": { "surface": "panel", "route": "/apps/pomodoro" }  // app 类型专属
}
```

| 类型 | 是什么 | 对应现状 | 新增能力 |
|------|--------|---------|---------|
| `tool` | 工具扩展 | 现有插件（setup 注册工具） | 生命周期 + 沙箱目录 |
| `skill` | 技能包 | 现有 .aw skill | 统一管理入口 |
| `agent` | 人设助手包 | 无（prompt 硬编码） | prompt+工具+技能打包为可安装应用 |
| `service` | 后台服务 | 无 | 常驻进程（MCP 包装 / 文件监听 / 轮询） |
| `app` | 交互式应用 | 无 | 独立 UI surface + 运行进程 |

**生命周期状态机**：

```
             install           start             stop
   (未安装) ───────► installed ────► running ◄──────── stopped
                          │  ▲          │              │
                          │  └──────────┘              │
                          └───────── destroy ──────────► destroyed(终态)
```

- `destroy` = 停止进程 + 卸载注册（工具/UI/权限全撤销）+ 删除 `data/apps/<id>/` + 广播 `app/destroy` + 写审计
- 现有 `pluginManager` **保留不删**，作为 `tool` 类应用的兼容加载器；新系统在其上包一层生命周期

**新增文件**：
- `src/core/app-manifest.ts` — manifest schema 校验（复用 package-installer 的 .aw 校验思路）
- `src/core/app-manager.ts` — 状态机 + 沙箱 + 权限 + 生命周期钩子，`appManager.getInstance()`
- `src/core/app-sandbox.ts` — 应用沙箱目录隔离 + 路径穿越防护（复用 fs 工具防护模式）

### 4.2 进程模型 — 一切皆进程

现在每次对话/任务都是"隐式进程"，显式化后 OS 可统一管理、可视化、限流：

```ts
type OsProcess =
  | { kind: "agent"; pid: string; agentId: string; sessionId: string;
      budget: ContextBudget; toolScope: string; status: "running"|"done"|"failed"|"killed" }
  | { kind: "app"; pid: string; appId: string; status: "starting"|"running"|"stopping"|"stopped" }
  | { kind: "job"; pid: string; jobId: string; status: "queued"|"running"|"done"|"failed" };
```

- `src/core/process-manager.ts` — 进程注册表 + 事件（`process/start|end`）+ 资源配额
- agent-loop 运行时登记 AgentProcess（注入 pid），结束时注销——**改动小、收益大**：Web 进程 Tab 实时可见"大脑在干什么"
- team-coordinator 的多专家协作 = 进程调度（每个专家一个 AgentProcess）
- 上下文资源：context-manager 增加"每进程 token 预算"上报，控制台展示内存占用

### 4.3 即时应用生成（AppFactory）— 用完留存或销毁

核心闭环：**用户一句话 → 生成应用 → 安装运行 → 留存或销毁**。

```
用户: "帮我做一个番茄钟"（CLI /app new 番茄钟，或 Web 按钮，或语音）
  │
  ▼
app-factory 识别目标类型（默认 app/webapp）→ 选模板
  │
  ▼
LLM 按模板生成: app.json + 入口代码 + README（一次生成，可迭代修正）
  │
  ▼
校验器: manifest schema 合法 + 代码语法检查（tsx/esbuild transform）
  │  失败 → 反馈 LLM 重试（≤2 次）或报错给用户
  ▼
安装: 写入 data/apps/<id>/ → appManager.install → start
  │
  ▼
运行: webapp → 注册 /apps/<id>/ 静态路由 + Web 应用面板入口
      tool   → 注册进 toolRegistry（LLM 立即可调用）
  │
  ▼
用户使用 → 满意: /app keep（留存，进入应用库）
          不满意: /app destroy <id>（干净销毁，代码进程权限全清）
```

**模板类型（MVP 五个）**：
| 模板 | 生成物 | 运行方式 |
|------|--------|---------|
| `webapp` | 单文件 HTML/JS + manifest | 静态服务 `/apps/<id>/`，Web 面板 iframe 渲染（**零构建**，不引 Svelte 编译链） |
| `tool` | Node 脚本 + 工具定义 | 注册进 toolRegistry |
| `agent` | 人设 YAML（prompt+工具+技能引用） | 注册进 agent 路由 |
| `skill` | SKILL.md | 注册进 skillRegistry |
| `service` | Node 常驻脚本 | app-manager 拉起子进程，心跳监控 |

**新增文件**：`src/core/app-factory.ts` + `src/core/app-templates/*.ts`（模板字符串）
**命令**：`/app new|list|start|stop|keep|destroy|install <路径>`
**安全**：生成应用默认 `permissions: []`（零授权），用到再申请；高危权限（network/terminal）需用户确认。

### 4.4 三模式交互

统一原则：**CLI / Web / 语音视频都是同一内核的不同"设备"**，共享同一套意图解析与事件流。

#### 4.4.1 语音/视频（全新建造）

```
语音输入:  Web 麦克风采集 → WebSocket 音频流 → ASR adapter → 文本进 chat
语音输出:  回复文本 → TTS adapter → Web Audio 播放
视觉输入:  Web 截图/摄像头帧 → base64 图片 → 多模态消息 → model-router
```

- `src/media/asr-provider.ts` — adapter 化：默认本地 `sherpa-onnx`（离线、隐私、中文好），可选云端（Whisper API）
- `src/media/tts-provider.ts` — adapter 化：默认 `edge-tts`（免费、无需 key），可换本地
- `src/media/media-server.ts` — WS 音频通道（复用 event-bus 所在 server，新增 `/api/v1/audio`）
- model-router 增加多模态能力标记：消息支持 `content: [{type:"text"|"image_url"}]`（openai-compatible 天然支持，改动集中在消息组装层）
- Web 端：`VoiceBar.svelte`（按住说话 / 语音会话模式开关）+ `ImageInput`（粘贴/截图上传）
- CLI 端语音：TUI 内不做实时语音（终端无标准音频），提供 `/voice` 透传 Web 端会话；**语音主战场在 Web**

#### 4.4.2 CLI 与 Web（已有，补齐 OS 管理命令）

新增 CLI：`/app`（应用生命周期）、`/evo`（进化）、`/os status`（OS 总览：进程数/应用数/模型/资源）
Web：SystemPanel → **AI OS 控制台**（见 4.6）

### 4.5 进化引擎 — 自进化闭环

把现在的"技能自动沉淀"升级为**系统级进化**，四阶段闭环：

```
Observe 观察      telemetry + 会话/工具日志 + 三层记忆 + 成功率/耗时/预算指标
   │
Propose 提议      meta-agent 定期分析 → 输出提案 proposal.json
                  （类型: new-tool / new-skill / new-app / config-change / prompt-fix）
   │
Test 测试         隔离环境验证：新工具跑冒烟用例、配置变更在临时实例试跑 → 评分
   │
Promote/Rollback  通过 → 应用 + 记入 data/evolution/ledger.json + 配置快照可回滚
                  失败 → 记录原因丢弃；运行后表现下滑 → 自动回滚上一快照
```

**护栏（fail-safe）**：
- 提案默认只"建议"，用户确认才应用（或 auto 模式 + 类型白名单自动应用）
- 每类变更限频（如每天 ≤3 条）、配置快照保留最近 N 份
- 所有进化动作走审计 + 广播 `evolution/*` 事件
- 回滚是硬能力：`/evo rollback <id>` 一键还原

**新增文件**：`src/core/evolution-engine.ts` + `data/evolution/{proposals,ledger,snapshots}/`
**Web**：进化 Tab（提案列表：采纳 / 拒绝 / 回滚按钮 + 台账时间线）

### 4.6 AI OS 控制台（Web SystemPanel 升级）

现有 8 Tab 升级为 OS 控制台：

| Tab | 内容 |
|-----|------|
| 上下文 | 已有 + 每进程 token 预算仪表 |
| 日志 | 已有 |
| 技能 / MCP / 配置 | 已有 |
| **应用**（改） | 应用列表 + 生命周期按钮 + "即时生成"入口 + 销毁确认 |
| **进程**（新） | Agent/App/Job 三类进程实时视图（状态、耗时、预算） |
| **设备**（新） | 语音/视觉通道状态 + 模型多模态能力 |
| **进化**（新） | 提案 / 台账 / 回滚 |
| 轨迹 | 已有 |
| 调度 | 已有，并入进程视图联动 |

---

## 五、实施路线（Sprint 34 → 38）

每个 Sprint 独立可交付、可验证，均含测试 + 实机验证 + 双 remote 推送。

### Sprint 34（0.7.0）— 内核：应用模型 + 进程模型
**目标**：插件升级为应用生命周期；进程显式化。
- `app-manifest.ts` / `app-manager.ts` / `app-sandbox.ts`（四类应用：tool/skill/agent/service，webapp 留到 35）
- `process-manager.ts` + agent-loop 登记 AgentProcess
- plugin-manager 兼容包装（现有插件照常加载，展示为 tool 类应用）
- CLI `/app list|start|stop|destroy|install` + Web「应用」「进程」Tab
- 验证：安装一个手写示例 tool 应用 → 运行 → 销毁 → 确认工具/文件/权限全清；单测覆盖状态机与 destroy 幂等

### Sprint 35（0.8.0）— AppFactory：即时生成应用
**目标**：一句话生成应用，留存/销毁闭环。
- `app-factory.ts` + 五模板（webapp/tool/agent/skill/service）+ 校验器
- Web `/apps/<id>/` 静态路由 + 应用面板（iframe）+ 生成向导 UI
- `/app new <描述>|keep|destroy` 全命令
- 验证：实机"帮我做一个番茄钟" → 生成→运行→使用→销毁，全程无手写代码；生成物非法时重试/报错路径单测

### Sprint 36（0.9.0）— 语音/视频交互
**目标**：三模式交互齐备。
- `media/` 三模块（asr/tts/media-server）+ WS 音频通道
- Web `VoiceBar` + 截图/图片提问；model-router 多模态消息
- 验证：Web 语音对话闭环（说→识别→回答→朗读）；截图提问走视觉模型

### Sprint 37（0.10.0）— 进化引擎
**目标**：自进化闭环。
- `evolution-engine.ts` 四阶段 + 台账 + 快照回滚 + 护栏
- Web「进化」Tab + `/evo` 命令
- 验证：注入模拟观察数据 → 提案 → 采纳 → 回滚全链路单测 + 实机观察一次真实进化

### Sprint 38（1.0.0）— AI OS 1.0 整合
**目标**：整合为可对外宣称的 AI OS 1.0。
- 控制台统一（设备/进程/应用/进化视图打磨）、安全加固（应用权限审查、审计完整）
- 性能（大上下文下多进程资源仪表）、示例应用包（.aw 打包番茄钟等 3 个示例）
- 文档：`docs/ai-os-architecture.md` 正式版 + README 更新

---

## 六、风险与取舍

| 风险 | 应对 |
|------|------|
| **即时生成应用 = 任意代码**（最大风险） | 权限声明制（默认零授权）+ 沙箱目录 + 高危权限需确认 + destroy 保证干净移除；MVP 进程内运行，后续可升级 worker 隔离 |
| 多应用/多进程挤占上下文预算 | context-manager 每进程配额 + 控制台可视化 + 超限自动降级（压缩/终止） |
| 本地 ASR 效果 vs 云端隐私 | adapter 化，默认本地 sherpa-onnx，可一键切云端 |
| 语音/视觉模型兼容 | 只依赖 openai-compatible 多模态消息格式，model-router 标记能力并降级 |
| 自进化失控 | 提案默认需确认、限频、快照回滚、全审计 |
| 破坏现有生态 | 插件/.aw 包全兼容；plugin-manager 保留为 tool 类加载器 |
| 范围过大（一次做太多） | 按 Sprint 拆分，每个 Sprint 独立可交付可验证 |

---

## 七、待确认问题

1. **webapp 模板技术栈**：推荐**纯 HTML/JS 单文件**（零构建、直接静态服务、生成最快）；若要 Svelte 组件级体验则引入构建链，复杂度显著上升。选哪个？
2. **语音 ASR 默认实现**：本地 sherpa-onnx（离线免费、需下载模型 ~100MB）还是云端优先（效果好、需 key）？
3. **进化引擎应用粒度**：提案默认"仅建议、用户确认"（保守，推荐），还是 auto 模式下全自动应用？
4. **AppFactory 生成 webapp 的渲染方式**：iframe 沙箱（隔离好，推荐）还是面板内嵌（体验好但隔离弱）？
5. **桌面端**：Web 已覆盖语音/视频/UI；是否需要在未来补 Tauri 桌面壳（可留到 1.0 之后）？
