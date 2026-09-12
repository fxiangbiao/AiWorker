# Sprint 48 — P0 收口（headless 模式 / 检查点与回滚）

> 依据：`plans/roadmap-next.md` P0-5、P0-6；`docs/主流Agent产品对比分析报告.md` 差距 4.2-#4、4.3-#12
> 版本：1.5.0 → 1.6.0（已收口）
> 状态：**已完成**（48.0～48.5 全部落地；提交前须经用户同意）
> 范围决定：本 Sprint **只做 P0-5 + P0-6**，闭合「可信基线」阶段验收；P1-4 权限记忆、P1-7 fs 写路径统一 → S49
> 回滚决定：fs 工具精确回滚 + `terminal_exec` 仅记录（不可回滚条目明示）；**Web 面板本轮同做**

---

## 一、目标

P0 剩下两条，都是「能不能被信任地交给脚本和别人用」的问题：

1. **headless（P0-5）**：`aiworker -p "<prompt>"` 一次性运行，输出结构化结果与稳定退出码，可被 CI / 脚本 / 其他 Agent 编排；
2. **检查点与回滚（P0-6）**：每轮有快照，`/rewind` 能把代码与对话退回到指定轮次之前，且回滚本身可解释、可预览、冲突可拦截。

完成判据（路线图 §六）：`npm run verify` 一条命令全绿、CI 双 job 绿、任何工具调用都能回答「谁允许的、按哪条规则、是否可撤销」——最后一句由本 Sprint 补齐「是否可撤销」。

---

## 二、设计

### 2.1 装配层抽取 `src/core/bootstrap.ts`（地基，零行为变更）

`src/index.ts` 的 `action` 闭包内一次性装配全部组件（约 1050 行），TUI / server / headless 三种前端共用同一条路径，无法在 headless 下跳过 TUI 与调度器。

- 抽出 `createRuntime(options: RuntimeOptions): Promise<Runtime>`，负责：目录准备 → 模型/会话/上下文 → 权限与审批 → hooks → 7 专家装配 → jobRunner/scheduler → MCP → 插件 → appRuntime/appManager → 进化引擎；
- `Runtime` 暴露：`agents`、`modelRouter`、`sessionStore`、`contextManager`、`approval`、`permissionModel`、`workingDir`、`dataDir`、`shutdown()`；
- `src/index.ts` 收敛为三层薄壳：`interactive`（现状 TUI + banner + 交互循环）、`server`（现状分支）、`headless`（新增）；
- **不变量**：`config/*.json` 仍按 `process.cwd()` 解析（不引入 rootDir 语义变更）；banner / 状态区 / 输入行全部留在 interactive 壳内；server 壳的 `startServer` 依赖对象逐字段保持不变；
- 守护：新增 `test/bootstrap.test.ts` 冒烟用例（装配成功、7 内置专家、工具注册非空、重复 `shutdown()` 幂等），既有 863 例必须全绿。

### 2.2 headless 模式（P0-5）

#### CLI 契约

```
aiworker -p "<prompt>" [--output-format text|json|stream-json]
                       [--session <id>] [--agent <id>]
                       [--mode ask|plan|auto] [--yes] [--max-iterations N]
```

| 参数 | 语义 |
|---|---|
| `-p, --print <prompt>` | 触发一次性运行（不进入交互循环）；与 `--server` 互斥，同时给出则报参数错误 |
| `--output-format` | `text`（默认，仅最终回答）/ `json`（仅末条 `result`）/ `stream-json`（NDJSON，一行一事件） |
| `--session <id>` | 续接既有会话（复用 `contextManager` 的会话历史）；缺省新建 |
| `--agent <id>` | 跳过路由，直接指定专家；缺省走 `routeToExpert` |
| `--mode` | 复用既有语义；headless 缺省仍取 `--mode` → `config/permissions.json:default_mode` → `auto` |
| `--yes` | 运行时**追加**一条 `{ tool: "*", action: "allow" }` 规则（不写盘） |
| `--max-iterations` | 覆盖本次运行的迭代上限（`config/agents/*.yaml` 仍为唯一持久来源） |

#### 事件流（`stream-json`）

```json
{"type":"system","sessionId":"...","model":"deepseek-chat","mode":"auto","agent":"coding"}
{"type":"thinking","delta":"..."}
{"type":"text","delta":"..."}
{"type":"tool_call","id":"call_1","name":"fs_write","args":"{...}"}
{"type":"tool_result","id":"call_1","name":"fs_write","success":true,"summary":"已写入 ..."}
{"type":"confirm_denied","tool":"terminal_exec","reason":"非交互模式无确认通道"}
{"type":"result","text":"...","sessionId":"...","iterations":3,"toolCalls":2,"usage":{...},"truncated":false}
{"type":"error","code":"llm_error","message":"..."}
```

- 事件由 `StreamCallbacks` 映射而来（`onThinkingDelta` / `onTextDelta` / `onToolCall` / `onToolResult`），无需改动 agent-loop；
- **stdout 纯净**：headless 下所有日志、告警、MCP/插件状态、`stat()` 全部改走 stderr（现状写 stdout），保证 `aiworker -p ... --output-format json | jq` 可直接消费；`text` 模式下最终回答写 stdout，其余写 stderr。

#### 审批与交互（关键安全设计）

- headless 启动时通过 `setConfirmProvider` 注册**立即拒绝**的确认通道：`() => Promise.resolve(null)`。不沿用 `requestConfirm` 的 stdin 回退——无 TTY 时它会挂满 30 秒甚至因 stdin EOF 异常；
- 被拒时输出 `confirm_denied` 事件（含工具名与拒绝原因），并在 stderr 给出可操作提示：写规则到 `config/permissions.json`，或用 `--yes` 显式放行；
- `ask_user` 在 headless 下同样注册「不可用」提供者并立即失败，绝不停住等输入；
- `--yes` 的边界（复用 S47 语义，不新开旁路）：**不能**绕过 `deny` 规则、`never_auto_approve` 清单、受保护路径，也**不能**绕过 `ask` 只读模式的写入拦截；它只把「默认需确认」降级为「免确认」；
- 审计：headless 与交互模式写同一份审计日志（`initAuditLog(dataDir)` 不跳过），保证「谁允许的」在无人值守场景同样可追溯。

#### 退出码

| 码 | 含义 |
|---|---|
| `0` | 成功（模型给出最终回答） |
| `1` | 运行失败（异常 / LLM 错误 / 工具链致命错误） |
| `2` | 参数错误（缺 prompt、`-p` 与 `--server` 冲突、未知 `--output-format`） |
| `3` | 权限拒绝导致无法完成（命中 fail-closed，且无规则放行） |
| `4` | 达到迭代上限（`truncated`） |
| `130` | 被中断（SIGINT / Ctrl+C） |

判定顺序：参数（2，装配前校验）→ 中断（130）→ 运行异常（1，含 agent-loop 折成 `text` 的循环异常）→ 权限拒绝（3）→ 迭代上限（4）→ 成功（0）。

> 实现注记：`AgentRunResult` 新增 `error` 字段——agent-loop 原本把循环内异常折成 `text`（"Agent 循环异常: …"）返回，headless 若不识别就会把连接失败/模型错误当成成功（退出码 0）。现在该字段显式带出错误，`json`/`stream-json` 的 `result` 载荷也含 `error`。

#### 生命周期与可测性

- headless 生命周期：**不**初始化 TUI/renderer、**不**打印 banner 与状态区、**不**跑首启引导、**不**启动 scheduler（`/schedule` 定时任务属交互/服务形态）；MCP 与插件照常加载（工具面需完整）；
- 运行结束：`telemetry.shutdown()` → `sessionStore.close()` → `process.exitCode = 退出码`（不 `process.exit()` 硬杀，避免丢 WAL 尾写）；
- 逻辑落 `src/core/headless-runner.ts`，签名 `runHeadless(deps, opts): Promise<{ exitCode; result }>`，deps 注入 agent 与 `write`/`writeErr` 输出 sink——**单测不 spawn 子进程**（Windows 沙箱下 piped stdio 不可靠，CI 上也更慢）；
- 参数解析抽纯函数 `parseHeadlessOptions(argv): { ok: true; opts } | { ok: false; error }`，覆盖冲突与非法值用例。

### 2.3 检查点（P0-6 上半）

#### 目录布局与 manifest

```
<dataDir>/checkpoints/<sessionId>/turn-<n>/
  manifest.json
  files/<sha1(absPath) 前 12 位>-<basename>      # 变更前内容（blob）
```

```json
{
  "sessionId": "…",
  "turn": 3,
  "createdAt": 1757500000000,
  "userInput": "把报告里的图片改成绝对路径",
  "messageSeqBefore": 12,
  "eventSeqBefore": 48,
  "files": [
    {
      "path": "D:\\ALAN\\Codes\\AiWorker\\ai_default_project\\reports\\x.md",
      "blob": "files/ab12cd34ef56-x.md",
      "existedBefore": true,
      "hashBefore": "…",
      "hashAfter": "…",
      "restorable": true,
      "tool": "fs_edit",
      "added": 3,
      "removed": 1
    },
    {
      "path": "D:\\ALAN\\Codes\\AiWorker\\ai_default_project\\dist\\out.js",
      "existedBefore": false,
      "restorable": false,
      "reason": "terminal_exec",
      "tool": "terminal_exec"
    }
  ]
}
```

#### 捕获点（复用既有 hook，不新写文件监控）

- `hooks/handlers.ts` 的 `captureDiff` 已在 `onToolCallPre` 读取 `fs_write` / `fs_edit` 的旧内容（内存 `snapshots`），在 `onToolCallPost` 计算新内容与行级 diff：**在同一位置**调用 `checkpointStore.capture(...)`（写 blob + manifest 条目）与 `checkpointStore.recordAfter(...)`（补 `hashAfter`）；
- `terminal_exec` 的文件变更由既有指纹扫描（`recordDirDiff`）发现，只落 `restorable: false` 条目，**不做目录级快照**（决策已定：避免单轮百 MB 落盘）；
- 轮次归属：`turn` 序号现由 hooks 的 turn logger 私有 `turnSeq` 维护。抽出 `src/hooks/turn-registry.ts`（`beginTurn(sessionId)` / `currentTurn(sessionId)` / `resetTurn(sessionId)`），turn logger 与检查点共用同一序号，避免两套计数器漂移；
- 上限与清理：单文件 > 2MB 或二进制 → 记 `skipped: too-large | binary`（不入 blob）；每会话默认保留最近 **20** 轮（常量 + `AIWORKER_CHECKPOINT_KEEP` 环境变量覆盖），超出按轮整目录删除；manifest 缺失/损坏 fail-soft（列检查点时标注「不可用」而不是抛错）。

### 2.4 `/rewind`（P0-6 下半）

#### 事件与投影

- 事件词汇扩展（`SessionEventMap` 本就是为声明合并预留）：`"rewind/applied": { toTurn, scope: "all"|"chat"|"code", files: string[], skipped: string[], conflicts: string[], at }`；
- **事件日志保持仅追加**：回滚不删事件，而是追加标记；
- `replayEvents` 识别 `rewind/applied`（`scope` 含 chat 时）→ 截断此前累积的消息，使派生视图与投影一致；`verifyProjection` 同步适配；
- `SessionStore.rewindMessages(sessionId, maxSeq, meta)`：同一事务内删除 `messages.seq >= maxSeq` 行 + 追加 `rewind/applied`（`seq` 为投影内自增列，删除后由 `MAX(seq)+1` 续接，保持唯一）；
- `turn_logs` / `tool_call_logs` / `snapshots/*.diff` **保留**：审计与轨迹仍可回看被回滚的历史，与「事件是唯一真源」不冲突。

#### 命令语义

| 用法 | 行为 |
|---|---|
| `/rewind` | 列出本会话检查点：轮次、时间、输入摘要、文件数、可恢复/跳过数 |
| `/rewind <n>` | 交互三选：**代码+对话** / **仅对话** / **仅代码**（走 `requestConfirm`，无通道 fail-closed） |
| `/rewind <n> --all\|--code\|--chat` | 非交互指定范围 |
| `/rewind <n> --dry-run` | 只打印将改动/删除的文件与将截断的消息数，不动任何东西 |
| `/rewind <n> --force` | 覆盖冲突（见下） |

语义：`/rewind <n>` = **回到第 n 轮开始之前**，即撤销第 n 轮及之后的全部改动。

#### 冲突检测（回滚安全阀）

- 恢复前比对当前文件内容哈希与 manifest 中该文件**最后一次**记录的 `hashAfter`：
  - 一致 → 正常恢复（写回 blob 内容；`existedBefore: false` 则删除该文件）；
  - 不一致（用户在 AiWorker 之外手改过、或被 `terminal_exec` 改过）→ 记为 `conflicts`，**默认拒绝**该文件，需 `--force`；
- 恢复顺序按轮次降序（先撤最新一轮），同轮内文件互相独立；
- 回滚后 `contextManager` 需重建会话消息视图（核对其是否按会话缓存 `messages`；若缓存则显式失效），并让 Web 端 `/sessions/:id`、`/diffs` 缓存签名失效（`/diffs` 现为目录签名 + 30s TTL，目录未变时会命中缓存）。

#### HTTP 与 Web（本轮同做）

- `GET /api/v1/sessions/:id/checkpoints` → `{ turns: [{ turn, createdAt, userInput, files, restorable, skipped }] }`；
- `POST /api/v1/sessions/:id/rewind` body `{ toTurn, scope, dryRun?, force? }` → `{ ok, applied, files, skipped, conflicts }`；
- 成功后沿用既有广播约定：`eventBus.broadcast({ type: "session/update", sessionId, kind: "rewind", toTurn, scope })`；
- Web 新增 `web/src/components/RewindPanel.svelte`（会话级面板，样式与交互对齐 `FileDiffPanel.svelte`）：检查点列表 + 三选 + `dry-run` 预览 + 冲突清单 + 二次确认（复用 `ConfirmModal.svelte`）；
- 入口：会话列表（`Sidebar.svelte`）与 `TopBar.svelte` 的当前会话操作区各一处；回滚成功后走既有会话重载路径刷新消息（`web/src/lib/stores/chat.svelte.ts`），并复用 Svelte 5 runes 的 store 回写规则（改 `store.messages` 元素必须取代理引用回写）。

### 2.5 测试计划

| 领域 | 用例 |
|---|---|
| bootstrap | 装配成功、7 专家、工具注册非空、`shutdown()` 幂等（+ 重复调用） |
| headless | `parseHeadlessOptions` 合法/冲突/非法值；三种 `output-format` 的输出形状；退出码 0/1/3/4 映射；确认被拒路径产出 `confirm_denied` 且不挂起；stdout 无非结构化污染 |
| 检查点 | capture → 改文件 → restore 还原；新建文件 restore 后删除；二进制/超限跳过；保留策略；manifest 损坏 fail-soft；`hashAfter` 冲突判定 |
| rewind | `rewind/applied` 事件回放后消息视图截断；`verifyProjection` 仍 ok；`rewindMessages` 事务性；`/rewind` 命令 handler（列表/范围/dry-run/冲突拒绝）；HTTP 端点（mock deps + `listen(0)` + fetch） |
| 回归 | 既有 863 例全绿，交互/服务行为不变 |

### 2.6 已知局限（诚实标注）

1. `terminal_exec` 造成的文件变更**不可回滚**（只记录，`/rewind code` 明确跳过并列清单）；需要覆盖时请用 `fs_write` / `fs_edit`；
2. 检查点只覆盖 AiWorker 自己改过的文件，不覆盖进程外部改动；外部改动会命中冲突拦截而非被静默覆盖；
3. 回滚是**文件级整体还原**（写回变更前内容），不重放 diff，因此无法只撤销部分行；
4. headless 是**单轮**执行：不做「后台长跑 + 查询状态」，长任务仍走 `/bg` 与 jobRunner。

---

## 三、验收

| 项 | 判据 |
|---|---|
| 后端 `tsc` / `eslint` | ✅ 无新增告警 |
| 全量测试 | ✅ 既有 863 例 + 新增约 35~45 例（headless / 检查点 / rewind / bootstrap） |
| `web:build` + `svelte-check --threshold error` | ✅ 0 错（新面板不引入 `as any` / `@ts-ignore`） |
| `npm run verify` | ✅ 一条命令 exit 0 |
| CI | ✅ 双 job 绿（push 后核对 run 结论） |
| headless 冒烟 | ✅ `node dist/index.js -p "1+1=?" --output-format json` 输出单个 JSON 且退出码 0；`--output-format json \| jq .type` 可用 |
| 回滚冒烟 | ✅ 让 Agent 改一个文件 → `/rewind <n> --code --dry-run` 预览 → 实滚 → 文件内容与改前一致、对话截断到该轮之前 |
| 文档 | ✅ `CHANGELOG.md` 1.6.0、`README.md`（headless 用法 + 退出码表 + `/rewind` + 局限）、本文件 |

---

## 四、任务分解与提交切分

| 序 | 任务 | 产出 |
|---|---|---|
| 48.0 | 装配层抽取 | `src/core/bootstrap.ts`、`index.ts` 三层壳、`test/bootstrap.test.ts` |
| 48.1 | headless | `src/core/headless-runner.ts`、CLI 参数、退出码、stderr 分流、`test/headless.test.ts` |
| 48.2 | 检查点 | `src/core/checkpoint-store.ts`、`src/hooks/turn-registry.ts`、captureDiff 接入、`test/checkpoint.test.ts` |
| 48.3 | 回滚 | `rewind/applied` 事件、`replayEvents` / `rewindMessages`、`/rewind` 命令、HTTP 端点、`test/rewind.test.ts` |
| 48.4 | Web 面板 | `RewindPanel.svelte`、`chat.svelte.ts` 接入、Sidebar/TopBar 入口、ws `session/update` 适配 |
| 48.5 | 收口 | 文档三件套、版本 1.6.0、`npm run verify`、CI 核对 |

提交切分（中文信息、全角标点、分支 `dev`、push `origin` + `gitee`，**经用户同意后执行**）：

1. `refactor: 抽出运行时装配层（为 headless 与检查点让路）`；
2. `feat: headless 一次性运行（-p + 结构化输出 + 稳定退出码）`；
3. `feat: 检查点与 /rewind 回滚（前后端 + 冲突检测）`。

---

## 五、本 Sprint 明确不做

1. **不做多轮 headless 会话编排**（`--continue` 轮询、prompt 文件批量、SDK 包）——先证明单轮可靠；续接用 `--session` 已够；
2. **不做 `terminal_exec` 的目录级/全量快照**；
3. **不做权限记忆（allow-always 一键记住）**——P1-4，S49；
4. **不做 fs 工具写路径统一走策略层**——P1-7，S49（与检查点的文件拦截点同源，适合一起做）；
5. **不做检查点的云端/跨机同步**；检查点只落本机 `dataDir`。

---

## 六、实施结果（收口记录）

| 项 | 结果 |
|---|---|
| 后端 `tsc` / `eslint src/` | ✅ 无错误、无告警 |
| 全量测试 | ✅ **909 / 63 文件**（863 → 909：bootstrap 6、headless 17、检查点 10、回滚 13） |
| `svelte-check --threshold error` | ✅ 0 错误（65 warnings 与基线持平） |
| `web:build` | ✅ |
| `npm run verify` | ✅ exit 0 |
| headless 真实端到端 | ✅ `-p "只回复两个字：好的" --output-format json` 单行 JSON + 退出码 0；`stream-json` 事件序列 `system → … → result`；`--mode plan` 下写工具被拦 → 退出码 3 且未落盘；参数错误退出码 2 |
| 回滚真实链路 | ✅ handlers 集成用例（`onMessage` → `captureDiff` → `restore`）与 HTTP 端点用例（列表 → dry-run 预览 → 执行 → 广播）均通过 |

### 实施中的三处偏离（均已同步代码与文档）

1. **参数校验前置**：`-p` 的参数错误在装配运行时之前判定（退出码 2 不必先连 MCP / 插件）；
2. **退出码判定顺序**：实测语义为 参数(2) → 中断(130) → 运行异常(1) → 权限拒绝(3) → 迭代上限(4) → 成功(0)（原文档把异常排在权限之后，已按实现更正为"异常优先"）；
3. **`AgentRunResult.error`**：agent-loop 把循环内异常折成 `text`，若不识别会把连接失败当成功（退出码 0）→ 新增该字段并由 headless 判 1，`result` 载荷也带 `error`。

### 冒烟过程中发现的环境事实（非缺陷，记录备查）

`data/runtime-config.json` 里持久化的 `profile: "lite"` 指向本地 `http://localhost:8000/v1`（`config/models.json` 的 lite profile）。
本地模型未启动时，模型调用会以 `Connection error.` 失败——这正是"运行失败必须体现在退出码上"的现实例子；
做端到端验证时使用独立 `--data-dir` 绕开该运行时覆盖。

