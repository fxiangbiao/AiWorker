# AiWorker → AI OS 架构规划

> 版本：v0.3（已补审核修订：能力桥/隔离强度/iframe 安全/权限映射/进化分层）
> 目标版本：0.7.0 → 1.0.0
> 一句话愿景：把 AiWorker 从"多智能体个人助手"升级为**个人 AI 操作系统**——AI 是大脑、Harness 是手脚、应用是进程、一切皆可即时生成、用完即毁。

### 修订记录

| 版本 | 内容 |
|------|------|
| v0.1 | 初始架构规划（应用/进程/即时生成/语音视频/进化五层） |
| v0.2 | 固化已确认决策（HTML 单文件/sherpa-onnx/仅建议/iframe/窗口体系/文档工作台/TUI 原则） |
| v0.3 | **审核修订**：补应用运行时能力桥、tool/service 子进程隔离、iframe 安全细节、app 权限与三模式审批映射；明确预算调度/事件订阅/TTS 离线/模型下载/应用升级/destroy 数据边界/多设备窗口状态；进化引擎补 5 层自进化与闭环细化 |

### 已确认决策（用户拍板）

| # | 决策项 | 结论 |
|---|--------|------|
| 1 | webapp 应用技术栈 | **纯 HTML/JS 单文件**，零构建，直接静态服务 |
| 2 | 语音 ASR 实现 | **本地 sherpa-onnx**（离线、隐私），adapter 化可切云端 |
| 3 | 进化引擎应用粒度 | **仅建议、用户确认**（保守可控） |
| 4 | 生成应用渲染方式 | **iframe 沙箱**（隔离优先） |
| 5 | 桌面端 Tauri 壳 | 留到 1.0 之后评估（暂不做） |
| 6 | 应用 UI 形态 | **三容器形态**（panel/float/widget）+ 统一窗口引擎，挂独立窗口层与现有布局解耦 |
| 7 | 文档型产出 | **不生成应用 UI**，统一走内置「文档工作台」渲染 |
| 8 | CLI/TUI 对 App | **TUI 只做管理+状态通知+跨设备联动，渲染归 Web** |

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

**应用运行时 API（能力桥）**——应用访问系统能力的唯一通道（无它则生成应用只能是"刷新即失的玩具"）：

```
webapp 类（iframe ⇄ 宿主，postMessage 协议）:
  storage.get/set    应用数据持久化（仅沙箱内 data/apps/<id>/data/）
  notify             系统通知（番茄钟到点）
  llm.call           应用内调用 LLM（可选）
  fs.read/write      沙箱目录内文件（需权限）
  http.fetch         需 network 权限

tool/service 类（子进程 ⇄ 主进程，stdin/stdout JSON-RPC）:
  ctx.storage / ctx.notify / ctx.llm / ctx.fs / ctx.http  同语义白名单 API
```

- 能力桥消息**统一带 appId + 权限校验**，未授权的能力直接拒绝并记审计
- 请求-响应带超时（默认 10s）与结果大小上限（复用 spillOrTruncate 思路）
- 协议版本化（`cap: 1`），宿主升级向后兼容

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
  │  注: 语法检查只保证"能解析"，不保证"行为安全"——
  │      运行时隔离见下方"隔离与资源限制"
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

**模板类型（MVP 五个，webapp 已确认为纯 HTML/JS 单文件）**：
| 模板 | 生成物 | 运行方式 |
|------|--------|---------|
| `webapp` | 单文件 HTML/JS + manifest | 静态服务 `/apps/<id>/`，Web 面板 **iframe 沙箱**渲染（零构建） |
| `tool` | Node 脚本 + 工具定义 | 注册进 toolRegistry |
| `agent` | 人设 YAML（prompt+工具+技能引用） | 注册进 agent 路由 |
| `skill` | SKILL.md | 注册进 skillRegistry |
| `service` | Node 常驻脚本 | app-manager 拉起子进程，心跳监控 |

**产出类型分流**（生成前判断——**不是所有应用都有 UI**）：

```
交互型（番茄钟/待办/电子宠物）──► webapp 模板 → iframe 窗口
文档型（报告/方案/文档）      ──► 文档模板 → 结构化文档（.md + data.json）
                                      │
                                      ▼
                      内置「文档工作台」（系统级 app，仅此一个）
                      目录树 + 图表 + 表格 + 代码块 + 一键导出 .md/.html
```

文档型产出**不生成独立应用 UI**，统一交给文档工作台渲染（只实现一次，LLM 只需产出标准 Markdown/JSON，生成最稳）。

**新增文件**：`src/core/app-factory.ts` + `src/core/app-templates/*.ts`（模板字符串）
**命令**：`/app new|list|start|stop|keep|destroy|install <路径>`
**安全（v0.3 强化）**：
- **隔离**：tool/service 类应用**不进程内加载**——`child_process` 子进程 + stdin/stdout JSON-RPC + 白名单 API（见 4.1 能力桥）；webapp 类天然在 iframe 内
- **运行时限制**：子进程超时（工具调用 60s）、内存上限（`resourceLimits`）、stdout 截断——防死循环/内存炸弹
- **权限**：生成应用默认 `permissions: []`（零授权），**运行时按需申请**（能力桥请求 → 现有 ask 通道确认：Web ConfirmModal / TUI stdin / 无确认通道默认拒绝）；高危（network/terminal）需用户确认；sandbox.ts 强制层扩展"应用权限"维度（先于权限层检查）
- 应用权限分**静态声明**（manifest 预授权，安装时展示给用户）+ **运行时申请**（动态补权，走 ask 通道）两种，均记审计

### 4.4 应用 UI 与窗口体系（AppWindow）

五类应用中仅 `app`（webapp）类型有独立 UI surface；tool/skill/agent/service 注册进对应注册表即可，无界面需求。

**三种容器形态**（统一窗口引擎，仅参数不同）：

| 形态 | 典型应用 | 特征 |
|------|---------|------|
| `panel` 工作区 | 文档工作台、数据看板 | 复用现有 modal 模式（SystemPanel 同款），可调尺寸的全屏级工作区 |
| `float` 悬浮窗 | 番茄钟、计算器 | fixed 自由定位，可拖拽/缩放/最小化/置顶 |
| `widget` 小部件 | 电子宠物、状态指示器 | 无边框透明、**永远置顶**、可拖到任意位置，点击展开为 float |

**统一窗口引擎（AppHost）**：
- 每个应用 iframe 外包一层系统容器（`AppHost.svelte`）：标题栏（拖拽手柄）+ 置顶/最小化/关闭
- 拖拽用 pointer 事件实现，**拖拽手柄在容器 chrome 上，iframe 内不做拖拽**（安全边界清晰，应用只画内容）
- 位置/尺寸按 appId 持久化 localStorage——电子宠物拖到右下角，刷新后仍在原地
- **z-index 分层**：内容布局 0-10 → float 40-80 → panel/modal 100 → **widget 200 永置顶**（系统弹窗打开时宠物依然可见）
- **与现有布局完全解耦**：应用不进 Sidebar/ChatPanel/右侧栏的 flex 流，挂独立窗口层 `AppHostLayer`（App.svelte 末尾追加，`{#each}` 遍历运行中的应用），现有组件零改动
- **widget 锚定浏览器视口（非 StatusBar）**：StatusBar 是 30px 底部信息行（model/tokens/cost/目录），widget 不进它的布局流、不挤占内容；默认初始位置 = 内容区右下角（距状态栏 12px），四角可配置，拖到状态栏上方也只是 fixed 层视觉覆盖
- 通信：iframe ⇄ 宿主走 postMessage（应用请求权限/通知/展开收起；宿主同步状态）
- 服务端：`/apps/<id>/index.html` 静态路由（路径穿越防护，复用 server.ts 静态托管模式）
- **懒挂载**：窗口关闭/应用停止即销毁 iframe（释放内存），恢复时重建——避免多窗口常驻 iframe 拖垮浏览器

**iframe 安全细节（v0.3 补充）**：
- `sandbox` 属性集：`allow-scripts`（必给）+ 按需 `allow-forms`/`allow-modals`；**不给 `allow-same-origin`**（防同源读取父页面 localStorage/状态）
- postMessage **必须校验 `event.origin`**（只接受宿主自身 origin），防第三方页面伪造消息；消息体带 appId 绑定
- 宿主不向 iframe 暴露任何敏感上下文（token/key/工作目录绝对路径），应用所需信息经能力桥按需下发

**多设备窗口状态边界（v0.3 明确）**：窗口位置/尺寸持久化 localStorage（单浏览器本地记忆）；跨设备一致性由**服务端进程注册表**驱动（窗口 open/focus/close 事件广播，各端按事件同步，位置不做跨端强一致——MVP 允许各端各自布局）。

**窗口可被大脑调度**（窗口是 OS 资源）：
```
window/list   查看所有应用窗口
window/focus  把某应用带到前台
window/close  关闭窗口（不销毁应用）
app/destroy   销毁应用（代码+进程+权限全清）
```

**窄屏降级**：float/widget 在窄屏自动降级为 panel 全屏，避免拖出视口。

### 4.5 三模式交互

统一原则：**CLI / Web / 语音视频都是同一内核的不同"设备"**，共享同一套意图解析与事件流。

#### 4.5.1 语音/视频（全新建造）

```
语音输入:  Web 麦克风采集 → WebSocket 音频流 → ASR adapter → 文本进 chat
语音输出:  回复文本 → TTS adapter → Web Audio 播放
视觉输入:  Web 截图/摄像头帧 → base64 图片 → 多模态消息 → model-router
```

- `src/media/asr-provider.ts` — adapter 化：默认本地 **sherpa-onnx**（离线、隐私、中文好，模型 ~100MB），可选云端（Whisper API）；模型首次使用需下载 → **下载管理器**（进度/断点续传/离线包，放 `data/media/models/`）
- `src/media/tts-provider.ts` — adapter 化：默认 `edge-tts`（免费、无需 key，**走微软在线接口**，断网/内网失效）；**本地备选 sherpa-onnx TTS（VITS 中文模型）**——与"本地优先"原则对齐，离线时自动降级
- `src/media/media-server.ts` — WS 音频通道（复用 event-bus 所在 server，新增 `/api/v1/audio`）
- model-router 增加多模态能力标记：消息支持 `content: [{type:"text"|"image_url"}]`（openai-compatible 天然支持，改动集中在消息组装层）
- Web 端：`VoiceBar.svelte`（按住说话 / 语音会话模式开关）+ `ImageInput`（粘贴/截图上传）
- CLI 端语音：TUI 内不做实时语音（终端无标准音频），提供 `/voice` 透传 Web 端会话；**语音主战场在 Web**

#### 4.5.2 CLI 与 Web（已有，补齐 OS 管理命令）

新增 CLI：`/app`（应用生命周期）、`/evo`（进化）、`/os status`（OS 总览：进程数/应用数/模型/资源）
Web：SystemPanel → **AI OS 控制台**（见 4.7）

**CLI/TUI 对 App 类的处理原则：TUI 是管理端 + 触发端，Web 是展示端**（终端无法渲染图形应用，不做伪渲染）：

| App 类型 | TUI 中的呈现 |
|---------|-------------|
| tool / agent / skill | 注册进对应注册表，CLI 会话中 LLM 直接可用，无需任何 UI |
| service | 后台运行，`/app status` / `/jobs` 查看 |
| webapp（app） | TUI 只做生命周期管理 + 状态通知：生成/启动/停止/销毁反馈 + 打印访问 URL（TUI markdown 已支持 OSC 8 超链接，可直接点击在浏览器打开） |

**跨设备联动**（一个 OS、多设备）：TUI 中 `/app new 番茄钟` → 生成完成广播 `app/started` 事件 → Web 端自动弹出窗口。终端发指令、浏览器看结果；Web 端窗口操作也可从 TUI 下发（`/app focus|close <id>`，经 event-bus 广播窗口指令）。

### 4.6 进化引擎 — 自进化闭环

**自进化体现在 5 个层次**（2 层已有，3 层由进化引擎新增）：

| 层次 | 内容 | 风险 | 进化方式 |
|------|------|------|---------|
| ① 技能自沉淀 | onTaskComplete → skill-evolution 把成功做法沉淀 SKILL.md | 低 | **自动**（已有，无需确认） |
| ② 记忆自组织 | 三层记忆 + 情景衰减 + FTS5 + MEMORY.md 有界维护 | 低 | **自动**（已有） |
| ③ 工具使用自优化 | 观察工具成功率/耗时/失败原因 → 提案改进工具描述/实现 | 中 | **用户确认** |
| ④ 能力自生长 | 发现重复性任务 → **调用 AppFactory 自己生成新工具/新应用** → 试用 → 留存或销毁 | 高 | **用户确认** |
| ⑤ 配置自调优 | 按任务类型调模型路由权重/temperature/预算 | 中 | **用户确认** |

**进化分层原则**：低风险（技能/记忆）自动进化不打断用户；高影响（工具/应用/配置）提案制、用户确认（已拍板"仅建议"）——一条原则贯穿，而不是笼统的"系统级进化"。

**④ 能力自生长是核心闭环**（自进化 × 即时生成的结合点，方案 v0.3 明确）：

```
Observe 发现: 同类任务本周出现 ≥3 次（如"每周整理会议纪要"）
   │
Propose: meta-agent 提案 "生成一个会议纪要整理工具"
   │
Test: AppFactory 生成 → 隔离子进程跑评测集 → 评分达标
   │
Promote: 用户确认采纳 → 留存为 tool 应用；拒绝则销毁
```

**四阶段闭环细化**：

```
Observe 观察（具体指标清单）
  - 工具调用成功率 / 耗时 / 失败原因分布
  - 上下文压缩率（压缩频繁 = 上下文结构问题）
  - 任务完成率（会话无结论即结束的比例）
  - 用户干预频率（ask/confirm 次数高 = 权限过严或意图不清）
  - 重复任务模式（同类任务重复出现次数）
  数据源: telemetry JSONL + 会话/工具日志 + 三层记忆 + TracePanel 轨迹
  触发: 定时（每日/每周）+ 事件（某工具连续 N 次失败、任务完成率跌破阈值）

Propose 提议
  meta-agent 分析观察数据 → 输出 proposal.json
  （类型: new-tool / new-skill / new-app / config-change / prompt-fix / tool-fix）

Test 测试
  - 评测集来源: 成功的会话轨迹沉淀为黄金用例（data/evolution/cases/）
  - 新工具/新应用: 隔离子进程跑评测用例 + 预算内试运行 → 评分
  - 配置变更: 临时实例试跑对比
  - 新应用额外要求: 通过 AppFactory 校验器（语法 + 沙箱）

Promote/Rollback
  - 通过 → 应用 + 记入 data/evolution/ledger.json + 配置快照可回滚
  - 推广后验证: A/B 对比（新旧并行跑 N 次，比成功率/token 效率/耗时）
  - 回滚: 表现下滑超阈值（如成功率 -20% 或耗时 ×2）→ 自动回滚上一快照
  - 失败 → 记录原因丢弃
```

**护栏（fail-safe，已确认：提案默认仅建议、用户确认）**：
- 提案默认只"建议"，用户点采纳才应用（auto 模式也不自动应用——保持保守可控）
- 每类变更限频（如每天 ≤3 条）、配置快照保留最近 N 份
- 所有进化动作走审计 + 广播 `evolution/*` 事件
- 回滚是硬能力：`/evo rollback <id>` 一键还原

**新增文件**：`src/core/evolution-engine.ts` + `data/evolution/{proposals,ledger,snapshots,cases}/`
**Web**：进化 Tab（提案列表：采纳 / 拒绝 / 回滚按钮 + 台账时间线 + 观察指标仪表）

### 4.7 AI OS 控制台（Web SystemPanel 升级）

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
- **能力桥 v1**：tool/service 子进程隔离（child_process + stdin/stdout JSON-RPC + 白名单 ctx API）+ 运行时限制（超时/内存上限）
- **权限映射**：静态声明（manifest）+ 运行时申请走现有 ask 通道；sandbox.ts 扩展应用权限维度
- `process-manager.ts` + agent-loop 登记 AgentProcess + **预算优先级**（前台会话 > 后台任务 > 应用）
- plugin-manager 兼容包装（现有插件照常加载，展示为 tool 类应用）
- CLI `/app list|start|stop|destroy|install` + Web「应用」「进程」Tab
- 验证：安装手写示例 tool 应用（子进程运行）→ 运行 → 权限拒绝路径 → 销毁 → 确认进程/工具/文件/权限全清；单测覆盖状态机、destroy 幂等、能力桥越权拒绝

### Sprint 35（0.8.0）— AppFactory：即时生成应用
**目标**：一句话生成应用，留存/销毁闭环。
- `app-factory.ts` + 五模板（webapp/tool/agent/skill/service）+ 校验器 + **产出类型分流**（交互型→webapp / 文档型→文档工作台）
- **Web 窗口体系**：`AppHostLayer` / `AppHost` + 三容器形态（panel/float/widget）+ z-index 分层 + 位置持久化 + postMessage 通信
- **iframe 安全**：sandbox 属性集（allow-scripts、无 allow-same-origin）+ postMessage origin 校验 + 路由路径穿越防护 + 懒挂载
- **webapp 能力桥**（postMessage 协议：storage/notify/llm/fs/http）+ **应用升级 update**（迭代生成不丢数据，版本管理）
- Web `/apps/<id>/` 静态路由 + 生成向导 UI
- **内置「文档工作台」系统应用**（文档型产出统一渲染：目录树/图表/导出）
- CLI/TUI：`/app new|keep|destroy|focus|close|update` + 跨设备联动（广播 `app/started` → Web 自动弹窗）
- `/app new <描述>|keep|destroy` 全命令
- 验证：实机"帮我做一个番茄钟" → 生成→运行→使用→销毁，全程无手写代码；生成物非法时重试/报错路径单测；iframe 越权消息被拒

### Sprint 36（0.9.0）— 语音/视频交互
**目标**：三模式交互齐备。
- `media/` 三模块（asr/tts/media-server）+ WS 音频通道 + **ASR 模型下载管理器**（进度/断点续传/离线包）
- **TTS 双实现**：edge-tts 在线 + sherpa-onnx VITS 本地备选（离线自动降级）
- Web `VoiceBar` + 截图/图片提问；model-router 多模态消息
- 验证：Web 语音对话闭环（说→识别→回答→朗读，含断网降级路径）；截图提问走视觉模型

### Sprint 37（0.10.0）— 进化引擎
**目标**：自进化闭环。
- `evolution-engine.ts` 四阶段 + 观察指标采集 + 提案 → 黄金用例评测（`data/evolution/cases/`）→ A/B 推广对比 → 快照回滚 + 护栏
- **能力自生长**：进化 × AppFactory 闭环（发现重复任务 → 生成新工具/新应用提案）
- **进化分层**：低风险自动（技能/记忆）+ 高风险确认制（工具/应用/配置）
- Web「进化」Tab（提案/台账/回滚/观察指标仪表）+ `/evo` 命令
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
| **即时生成应用 = 任意代码**（最大风险） | **tool/service 子进程隔离**（JSON-RPC + 白名单能力桥）+ iframe sandbox（无 allow-same-origin）+ 默认零授权 + 运行时权限走 ask 通道 + 子进程超时/内存上限 + destroy 干净移除 |
| 多应用/多进程挤占上下文预算 | context-manager 每进程配额 + **优先级规则**（前台会话 > 后台任务 > 应用）+ 超限降级（压缩/终止） |
| event-bus 全量广播放大 | 事件**按类型订阅过滤**（进程/应用/进化事件不推给无关客户端），前端只渲染可见窗口状态 |
| TTS 离线失效 | edge-tts 在线 + **sherpa-onnx VITS 本地备选**，离线自动降级 |
| 本地 ASR 效果 vs 云端隐私 | adapter 化，默认本地 sherpa-onnx，可一键切云端 |
| 语音/视觉模型兼容 | 只依赖 openai-compatible 多模态消息格式，model-router 标记能力并降级 |
| 自进化失控 | **分层**：低风险自动（技能/记忆）、高风险确认制（工具/应用/配置）+ 限频 + 快照回滚 + 全审计 |
| 破坏现有生态 | 插件/.aw 包全兼容；plugin-manager 保留为 tool 类加载器 |
| 范围过大（一次做太多） | 按 Sprint 拆分，每个 Sprint 独立可交付可验证 |

---

## 七、待确认问题

1. **webapp 模板技术栈**：推荐**纯 HTML/JS 单文件**（零构建、直接静态服务、生成最快）；若要 Svelte 组件级体验则引入构建链，复杂度显著上升。选哪个？
2. **语音 ASR 默认实现**：本地 sherpa-onnx（离线免费、需下载模型 ~100MB）还是云端优先（效果好、需 key）？
3. **进化引擎应用粒度**：提案默认"仅建议、用户确认"（保守，推荐），还是 auto 模式下全自动应用？
4. **AppFactory 生成 webapp 的渲染方式**：iframe 沙箱（隔离好，推荐）还是面板内嵌（体验好但隔离弱）？
5. **桌面端**：Web 已覆盖语音/视频/UI；是否需要在未来补 Tauri 桌面壳（可留到 1.0 之后）？
