# Sprint 34 — AI OS 内核：应用模型 + 进程模型（0.7.0）

> 状态：**📋 待确认**
> 需求：AI OS 架构升级第一阶段——插件升级为应用生命周期（tool/skill/agent/service 四类）、进程显式化、能力桥子进程隔离、Web UI 基础优化
> 设计依据：`docs/AIOS-架构升级方案.md` §4.1/4.2/4.8 + Sprint 34
> 2026-08 规划

---

## 一、目标与范围

**一句话**：把 AiWorker 从"插件 + 隐式会话"升级为"应用生命周期 + 显式进程"，为即时生成（Sprint 35）打地基。

| 优先级 | 内容 |
|--------|------|
| **P0** | 应用模型（manifest/app-manager/app-sandbox）+ 能力桥子进程（JSON-RPC 隔离）+ CLI `/app` + Web「应用」Tab + 单测 |
| **P0** | process-manager + agent-loop 登记 AgentProcess + Web「进程」Tab |
| **P0** | plugin-manager 兼容包装（现有插件展示为 tool 类应用，零破坏） |
| **P1** | Web UI 🟢 五项：暗色模式 / lucide 图标统一 / 细滚动条 / `:focus-visible` / 空状态启动台 |
| **P1** | 状态持久化与恢复（state.json / autostart / 崩溃指数退避重启）+ 权限映射（sandbox 扩展 + ask 通道） |
| **P2** | 左侧 OS 导航（对话/应用/任务/设置）+ StatusBar 进程/应用计数 |

**明确不做（留后续）**：webapp 类型与窗口体系（Sprint 35）、文档工作台（35）、语音（36）、进化引擎（37）、预算配额执行机制（34 只做注册表+优先级标记，配额逻辑后续）。

## 二、后端设计

### 2.1 应用清单（manifest，`src/core/app-manifest.ts`）

```ts
// data/apps/<id>/app.json（webapp 类型 schema 预留，Sprint 34 不启用）
interface AppManifest {
  id: string;                    // kebab-case
  type: "tool" | "skill" | "agent" | "service";  // "app" 预留
  name: string;
  version: string;
  description: string;
  entry: string;                 // 相对沙箱目录的入口文件
  permissions: string[];         // 静态声明：network | notify | llm | fs:data/apps/<id>
  tools?: AppToolDecl[];         // tool 类型：注册的工具声明（name/description/parameters）
  lifecycle?: { onStart?: string; onStop?: string; onDestroy?: string };
  originSessionId?: string;
  autostart?: boolean;           // service 类型：OS 启动自动拉起
}
```

- **权限白名单**（schema 硬约束）：`network` / `notify` / `llm` / `fs:data/apps/<id>`（沙箱内 fs 自动含）；**`terminal` 值直接 schema 拒绝**（v0.5 决策）
- 工具声明校验：name 合法（`^[a-z][a-z0-9_]{1,63}$`）、description 非空、parameters 为 JSON Schema object

### 2.2 app-manager（`src/core/app-manager.ts`）

- 单例 `appManager.getInstance()`；状态机 `installed → starting → running → stopping → stopped`，`destroyed` 终态
- 目录布局：`data/apps/<id>/{app.json, <entry>, data/}`（data/ 为沙箱数据目录）
- **install**：校验 manifest → 复制到沙箱目录 → 写入 `data/apps/state.json` → 广播 `app/installed`
- **start/stop**：tool 类启动 = 拉起子进程；skill/agent 类 start = 注册进 skillRegistry/agent 路由（无进程）
- **destroy**：stop 进程 + 卸载注册 + 删除 `data/apps/<id>/` + 从 state.json 移除 + 广播 `app/destroyed` + 审计；**幂等**（已销毁再 destroy = no-op 成功）
- **持久化与恢复**：state.json 记录 `{ status, autostart, crashCount, lastError }`；启动时恢复——installed 回到 stopped，`autostart: true` 的 service 自动拉起
- **兼容包装**：`list()` 合并 pluginManager.getPlugins()（现有插件映射为 tool 类应用视图，不动 plugin-manager 本体）

### 2.3 能力桥子进程（`src/core/app-runtime.ts`）

**隔离**：`child_process.spawn(process.execPath, ["--max-old-space-size=256", entry], { cwd: 沙箱目录, env: sanitizeEnv(...) })`——不进程内加载，V8 堆上限 256MB 防内存炸弹。

**协议**：stdin/stdout **行分隔 JSON-RPC**（每行一个 JSON，防粘包；stderr 仅日志）。

```
主进程 → 子进程:
  {"id":1,"method":"tool.call","params":{"name":"...","args":{...}}}   // 工具调用
  {"id":2,"method":"app.stop","params":{}}                             // 停止通知
子进程 → 主进程:
  {"id":1,"result":{...}} 或 {"id":1,"error":{"code":"ERR_*","message":"..."}}
  {"method":"app.ready","params":{}}                                   // 启动握手
  {"method":"app.log","params":{"level":"info","msg":"..."}}           // 日志上报
```

**能力 API（子进程侧 ctx）**：`ctx.storage.get/set`（沙箱 data/ 内）、`ctx.notify`、`ctx.llm.call`、`ctx.fs.read/write`（需权限）、`ctx.http.fetch`（需 network）。**无 terminal**。

**错误码（稳定化）**：`ERR_PERMISSION` / `ERR_TIMEOUT` / `ERR_NOT_FOUND` / `ERR_INTERNAL`。

**运行时限制**：
- 工具调用超时 60s（对齐 agent-loop toolTimeoutMs，超时 kill）
- stdout/stderr 各截断 1MB（复用 spillOrTruncate 思路）
- 心跳：主进程每 15s ping，无响应视为崩溃
- **崩溃重启**：指数退避 1s/2s/4s ≤3 次，仍失败置 failed + 审计 + 广播 `app/crashed`
- 工具调用并发：同一子进程串行处理（简单可靠，MVP）

**权限检查**：能力桥请求 → `app-sandbox.check(capability, appId)` 强制层（先于权限层）→ 静态声明命中放行 → 未声明走 ask 通道 → 拒绝返回 `ERR_PERMISSION` + 审计。

### 2.4 进程模型（`src/core/process-manager.ts`）

```ts
type OsProcess =
  | { kind: "agent"; pid: string; agentId: string; sessionId: string;
      status: "running"|"done"|"failed"|"killed"; priority: "front"|"bg"; startedAt: number; endedAt?: number }
  | { kind: "app"; pid: string; appId: string; status: "starting"|"running"|"stopping"|"stopped"|"failed" }
  | { kind: "job"; pid: string; jobId: string; status: "queued"|"running"|"done"|"failed" };
```

- 注册表 + `subscribe` 事件（`process/start|end|update`）→ event-bus 广播
- agent-loop 登记：`runAgentLoop` 入口注册 AgentProcess（priority: front），完成/失败/中断注销（改动点：index.ts 注入 processManager，agent-loop deps 加可选 processManager，未注入则跳过——保持向后兼容与单测隔离）
- job 进程：job-runner 提交/完成时同步注册（在 job-runner 的 submit/done/failed 钩子挂 process-manager）
- 预算优先级标记：front（前台会话）> bg（后台任务/job）> app；MVP 只记录与展示，配额执行后续

### 2.5 权限映射（`src/security/sandbox.ts` + ask 通道）

- sandbox.ts 新增 `checkAppCapability(appId, capability)`：静态声明命中 → 放行；未声明 → 走 ask 通道（复用 approval-service/ask-channel，30s 超时拒绝 fail-closed）
- 静态声明在 install 时展示（CLI 输出 / Web 确认卡片）
- 高危（network）运行时申请走确认；notify/llm 可走 ask 或直接询问

## 三、CLI 与 HTTP

### 3.1 CLI `/app` 命令组（`src/commands/apps.ts`）

```
/app list                列出全部应用（类型/状态/权限）
/app info <id>           manifest 详情 + 权限 + 工具声明
/app install <路径>      安装（目录或 .aw 包；.aw 复用 package-installer，目录为 Sprint 34 主路径）
/app start <id>          启动
/app stop <id>           停止
/app destroy <id>        销毁（二次确认，提示含应用数据）
```

注册进 `src/commands/registry.ts`；`/help` 自动生成。

### 3.2 HTTP 端点（`src/server.ts`）

```
GET  /api/v1/apps            应用列表（含权限/状态/工具）
POST /api/v1/apps/install    安装（body: path）
POST /api/v1/apps/:id/start|stop|destroy
GET  /api/v1/processes       进程列表（三类）
```

`/apps` `/processes` 变更经 event-bus 广播（`app/*` / `process/*`），前端 WS 订阅实时刷新。

## 四、Web UI（前置优化 + 新 Tab）

### 4.1 🟢 低成本五项（P1）

| # | 项 | 实现 |
|---|-----|------|
| 1 | **暗色模式** | app.css 加 `[data-theme="dark"]` 变量覆盖；TopBar 主题开关；localStorage `aiworker-theme`；默认跟随 prefers-color-scheme |
| 2 | **lucide 图标** | web 安装 `lucide-svelte`（验证 Svelte 5 兼容，不兼容退回内联 SVG）；替换全部 emoji/HTML 实体图标（TopBar/Sidebar/StatusBar/SystemPanel/ChatPanel 等 20+ 处） |
| 3 | **细滚动条** | 全局 6px 滚动条（hover 加深）+ Firefox `scrollbar-width: thin` |
| 4 | **`:focus-visible`** | 全局 outline 样式；`role="button"` 元素补齐键盘焦点 |
| 5 | **空状态启动台** | ChatPanel 消息为空时显示启动卡片（新对话 / 生成应用 / 打开进程 / 语音输入）——生成应用/语音入口暂置灰或提示"规划中" |

### 4.2 OS 导航 + 状态栏（P2）

- Sidebar 顶部一级导航：**对话 / 应用 / 任务 / 设置**——对话=原会话列表，应用=新 AppsPanel，任务=jobs 列表小面板，设置=打开系统弹窗
- StatusBar：加「进程 N · 应用 M」计数 + token 用量细进度条

### 4.3 新组件

- `AppsPanel.svelte`：应用列表（类型/状态/权限徽标）+ 生命周期按钮 + 销毁确认（复用 ConfirmModal）
- `ProcessesPanel.svelte`：三类进程实时视图（WS 事件驱动，状态色标）
- `web/src/lib/stores/apps.svelte.ts`：应用/进程 store + WS 订阅（`app/*` `process/*`）

## 五、开发顺序

1. `src/types.ts` 补类型（AppManifest/AppInfo/AppToolDecl/OsProcess/AppCapability）
2. `app-manifest.ts` schema 校验（含 terminal 拒绝）
3. `app-manager.ts` 状态机 + state.json 持久化 + 恢复 + destroy 幂等
4. `app-runtime.ts` 子进程 + JSON-RPC 能力桥 + 心跳 + 崩溃重启
5. `app-sandbox.ts` 权限检查 + `sandbox.ts` 扩展 + ask 通道映射
6. `commands/apps.ts` + registry 注册
7. `process-manager.ts` + agent-loop/job-runner 登记
8. plugin 兼容包装
9. server 端点 + 事件广播
10. Web：🟢 五项 → AppsPanel/ProcessesPanel → OS 导航/StatusBar
11. 测试补全 + 实机验证

## 六、测试计划

| 文件 | 覆盖 |
|------|------|
| `test/app-manifest.test.ts` | schema 合法/非法；`terminal` 权限被拒；工具声明校验 |
| `test/app-manager.test.ts` | 状态机全路径；install/start/stop/destroy 幂等；state.json 持久化与启动恢复；autostart 拉起；插件兼容 list |
| `test/app-runtime.test.ts` | 子进程启停；tool.call 正常/超时/崩溃；能力桥越权（storage/fs/http/notify）→ ERR_PERMISSION；输出截断；崩溃指数退避重启（kill 子进程验证） |
| `test/process-manager.test.ts` | 注册/注销/事件广播/优先级标记 |
| `test/server.test.ts` | `/apps` `/processes` 端点（mock appManager） |
| 回归 | 现有 457 测试全绿（agent-loop 未注入 processManager 时行为不变） |

测试隔离：app 相关测试用 `makeTestDir` 独立 data 目录 + 注入 dataDir；子进程测试用真实临时脚本（写测试 fixture 入口文件）。

## 七、实机验证清单

1. 手写示例 tool 应用（注册 `hello_app` 工具 + 读沙箱内文件）→ `/app install` → `/app list` → 对话中调用 → `/app stop` → `/app destroy` → **确认进程/工具/文件/权限全清**
2. 越权：应用调用未授权 `fs.write` → 拒绝 + 审计可见
3. 崩溃恢复：`/app start` 后 kill 子进程 → 观察指数退避重启 → 审计记录
4. service 应用 `autostart: true` → 重启 OS → 自动拉起
5. Web「应用」「进程」Tab 实时状态（WS 驱动）
6. Web UI：暗色模式切换记忆、图标统一、滚动条、键盘焦点、空状态启动台
7. `/help` 出现 `/app` 命令组

## 八、涉及文件

**后端**：`src/types.ts`、`src/core/app-manifest.ts`（新）、`src/core/app-manager.ts`（新）、`src/core/app-runtime.ts`（新）、`src/core/app-sandbox.ts`（新）、`src/core/process-manager.ts`（新）、`src/security/sandbox.ts`、`src/commands/apps.ts`（新）、`src/commands/registry.ts`、`src/index.ts`、`src/agents/agent-loop.ts`、`src/core/job-runner.ts`、`src/server.ts`、`src/commands/format.ts`（如需）

**前端**：`web/package.json`（+lucide-svelte）、`web/src/app.css`、`TopBar.svelte`、`Sidebar.svelte`、`StatusBar.svelte`、`ChatPanel.svelte`、`SystemPanel.svelte`、`AppsPanel.svelte`（新）、`ProcessesPanel.svelte`（新）、`web/src/lib/stores/apps.svelte.ts`（新）、其他组件图标替换

**测试**：`test/app-manifest.test.ts`（新）、`test/app-manager.test.ts`（新）、`test/app-runtime.test.ts`（新）、`test/process-manager.test.ts`（新）、`test/server.test.ts`

## 九、风险与取舍

| 风险 | 应对 |
|------|------|
| lucide-svelte 与 Svelte 5 不兼容 | 安装即验证；不兼容退回内联 SVG 图标组件 |
| 子进程 JSON-RPC 粘包/拆包 | 行分隔 JSON（每行一个消息），禁用嵌入换行 |
| Windows spawn node 路径 | 用 `process.execPath`（绝对路径），不依赖 PATH |
| 子进程内存炸弹 | `--max-old-space-size=256` + 超时 kill + 输出截断 |
| .aw 包安装应用 | Sprint 34 主路径为目录安装；.aw 复用 package-installer 已有 plugin 路由，app 打包规范 Sprint 35 定 |
| 预算配额执行 | Sprint 34 只做注册表 + 优先级标记 + 展示，执行机制后续 Sprint |
| 破坏现有插件生态 | plugin-manager 本体零改动，仅 app-manager.list() 做视图合并 |
