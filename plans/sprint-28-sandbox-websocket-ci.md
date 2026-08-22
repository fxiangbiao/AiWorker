# Sprint 28 — 执行沙箱 + WebSocket 双工 + CI（含测试修复）

> 状态：**✅ 已实施**（2026-08-15，版本 0.3.0，提交见下）
> 范围：用户选定"全做：一个批次" = 0 测试修复+fixture 化 → 1 CI → 2a 执行沙箱 → 2b WebSocket
> 依据：`docs/comparison-report.md` 第五条 8 项差距盘点（#3 沙箱、#8 WebSocket 为剩余未落地项）+ 实机发现的工程问题

---

## 实施记录（与计划的偏差）

1. **2a denyCommands 用子串匹配**（计划写"前缀匹配"）：子串防 `echo rm -rf` 类绕过，误伤面由用户显式配置承担，安全优先
2. **2a terminal_session 不做 cwd 约束**（计划写"同样检查"）：会话 cwd 有状态（cd 跨调用保留）无法可靠追踪，仅 denyCommands + env 清理；cwd 约束只对 terminal_exec（cwd 为显式参数）
3. **2b 前端 WS 只消费同步事件**（计划写"抽公共层双通道共用"）：SSE 与 WS 双写同一批任务事件，若前端共用处理会重复渲染；故 SSE 保持发起标签页唯一事实源，WS 仅处理 `session/update` + 非流式期间的 `done`（多标签同步），风险显著低于原方案
4. **CI 拆两个 job**：`test`（windows+ubuntu matrix：lint+build+test）+ `web-build`（ubuntu）
5. **npm scripts 跨平台化**：`set NODE_OPTIONS=...`（CMD 专属）→ `cross-env`（新增 devDep）
6. 测试总数：332 → **345**（沙箱 9 + WS 4）

## 提交

- `f392bbf` feat(release): 0.3.0 — 执行沙箱 + WebSocket 实时总线 + CI + 测试隔离（已推送 GitHub 443 / Gitee）

---

## 背景：对照 comparison-report 的差距现状

| # | 差距 | 现状 |
|---|---|---|
| 1 插件机制 / 2 scoped 工具 / 4 事件溯源 / 5 审批服务 / 6 LLM seam | — | ✅ 已落地（Sprint 27 及之前） |
| 3 进程级沙箱 | **本批 2a** | ❌ 仅路径校验 + danger-detector 正则 |
| 7 OTel/轨迹 | 🟡 telemetry+trace 已有 | OTel 导出后端不在本批（低优先） |
| 8 WebSocket 双工 | **本批 2b** | ❌ SSE 单向，无服务端主动推送 |

另外两个实机发现的工程问题并入本批：
- `config/models.json` 有未提交本地改动（lite 换模型 + 去 default temperature/maxTokens）→ 挂了 2 个测试
- 项目零 CI；npm scripts 里 `set NODE_OPTIONS=...` 是 Windows CMD 语法，Linux 直接跑不了

---

## 0. 测试修复 + fixture 化

### 现状
- `config/models.json` 未提交改动：default profile 删除 `temperature`/`maxTokens`；lite 模型 `Qwen3.6-35B-A3B-UD-IQ3_S` → `Qwen3.8-27B-UD-IQ2_XXS`、maxTokens 16384 → 4096
- `test/streaming-terminal.test.ts` 第 53、73 行硬编码旧模型名 → `npm test` = 330/332，2 失败
- 根因：测试直接 `new ModelRouter()` 读真实 `config/models.json`

### 方案
1. **models.json 改动提交入库**（合理配置更新，随版本走；default 删 temperature/maxTokens 后走代码默认值，lite 换新模型是用户实调结果）
2. **fixture 化**：新建 `test/fixtures/models.json`（精简两 profile：default + lite，保持 ≥2 个可断言）；`streaming-terminal.test.ts` 两处 `new ModelRouter()` 改 `new ModelRouter(join(import.meta.dirname, "../fixtures/models.json"))`
3. grep 全库 `new ModelRouter(` 确认是否还有其他测试读真实配置，一并改
4. 断言同步：fixture 里 lite 模型名写当前值，测试断言 fixture 值（不再依赖真实配置）

### 验收
- `npm test` 全绿（332+）
- 测试与真实 `config/models.json` 解耦（改配置不再碎测试）

---

## 1. GitHub Actions CI

### 前置坑（必须先修）
- `package.json` scripts：`test`/`dev`/`start` 用 `set NODE_OPTIONS=--no-deprecation &&`（CMD 专属）→ 引入 `cross-env` devDep，改为 `cross-env NODE_OPTIONS=--no-deprecation vitest run` 等，跨平台且行为不变
- `test/terminal-session.test.ts` 真实 spawn `cmd.exe` → 用例加 `it.skipIf(process.platform !== "win32")`（保持 Windows 实机覆盖，Linux 跳过）

### 方案
- 新建 `.github/workflows/ci.yml`
- 触发：push（main + dev）+ pull_request + workflow_dispatch
- matrix：
  - `windows-latest`：lint + build(tsc) + vitest 全量
  - `ubuntu-latest`：lint + build(tsc) + vitest（win32-only 已跳过）+ `npm run web:build`
- 步骤：checkout → setup-node 22（cache npm）→ `npm ci` → `npm run lint` → `npm run build` → `npm test` →（ubuntu 加）`npm run web:build`
- 环境：`DEEPSEEK_API_KEY` 设 dummy（测试全 mock，不真实调 API）
- README 徽章行加 CI 状态徽章

### 验收
- 推送到 dev 后 CI 两个 runner 全绿
- `npm test`/`npm run dev`/`npm run start` 在 Linux shell 可用

---

## 2a. 执行沙箱（策略化命令沙箱）— 报告 #3

### 定位与边界（诚实声明）
- **不做 OS 级进程沙箱**（bwrap / macOS Seatbelt / Windows restricted-token）：Node 无原生 API、自研 restricted token 风险高、本项目信任模型 = 用户本人执行的命令
- 落地**声明式策略沙箱 + 环境清理 + 现有纵深**（danger-detector + 路径校验 + withTimeout + spill 输出截断），构成多层防御

### 方案
1. 新建 `config/sandbox.json`（策略文件，strip BOM 加载，带默认值）：
   ```json
   {
     "enabled": true,
     "allowDirs": [],           // 空 = 默认仅 workingDir
     "denyCommands": [],        // 配置化危险命令前缀，追加在 danger-detector 之上
     "stripSecretEnv": true     // 执行时剥离含 KEY/TOKEN/SECRET/PASSWORD 的环境变量
   }
   ```
2. 新建 `src/security/sandbox.ts`：
   - `SandboxPolicy` 类型 + `loadSandboxPolicy()`（读 config/sandbox.json，缺失/损坏回退默认值）
   - `checkCommand(command, cwd, workingDir, policy)` → `{ allowed, reason? }`：
     - **cwd 约束**：cwd 必须位于 allowDirs（空则 = workingDir）内（`path.relative` 校验，与 fs_write 同款），越界 fail-closed
     - **denyCommands**：命令前缀匹配拒绝
   - `sanitizeEnv(env)`：剥离敏感变量（KEY/TOKEN/SECRET/PASSWORD）
3. 接入：
   - `src/tools/builtin.ts` `execCmdHandler`：执行前 `checkCommand`（**强制层**，先于权限层，任何模式都拦）；spawn env 过 `sanitizeEnv`
   - `src/tools/terminal-session.ts`：exec 前同样检查 + env 清理
4. 默认策略宽松（allowDirs 空、denyCommands 空、stripSecretEnv 开）：不改变现有实机行为，仅新增安全纵深

### 测试（`test/sandbox.test.ts` + builtin 集成）
- 策略加载：默认值、allowDirs 生效、denyCommands 匹配、BOM 容错
- cwd 越界拒绝 / workingDir 内放行 / allowDirs 放行
- sanitizeEnv 剥敏感变量、保留 PATH 等
- terminal_exec 集成：cwd 越界返回明确错误

### 验收
- 实机（Windows）`cd 到工作区外` 的 terminal_exec 被拒，正常命令不受影响
- 全绿测试

---

## 2b. WebSocket 双工 — 报告 #8

### 架构决策
- **分层**：SSE = 单次任务（chat/plan/debate）的请求-响应事件流（保留不动）；**WS = 全局实时总线**（服务端主动推送：会话元数据变更、任务事件广播、多端同步）
- 上行仍走 REST POST（chat/confirm/ask 语义不变），WS 只做下行广播 → 改动面可控
- 依赖：`ws`（dependencies）+ `@types/ws`（devDependencies）

### 方案
1. **事件总线**：新建 `src/server/event-bus.ts` → `EventBus`（单例或注入）：`subscribe(cb)` / `broadcast(obj)` / `close()`；WS 客户端集合 + 心跳（30s ping/pong）+ 断线清理
2. **server.ts**：
   - HTTP server `upgrade` 处理 `/api/v1/ws`（ws 包 WebSocketServer({ noServer: true }) + handleUpgrade）
   - chat/plan/debate 端点的 `write` 闭包统一改为 `write(data){ res.write(SSE); bus.broadcast({ ...data, sessionId }); }`
   - 会话操作点（创建/重命名/删除/消息追加/导出）广播 `session/update` 事件
3. **事件分发抽公共层**：把 ChatPanel.svelte 里 SSE 解析 + `handleSSE` 的事件处理逻辑抽到 store 层（`web/src/lib/stores/stream.svelte.ts` 已有雏形）→ `handleStreamEvent(data)`，SSE reader 与 WS 消费共用
4. **前端 WS**：`web/src/lib/stores/ws.svelte.ts`（或并入 stream store）：按 `location.protocol` 拼 ws/wss URL、自动重连（指数退避）、收到事件 → `handleStreamEvent`；会话元数据事件 → 刷新 session 列表
5. **vite.config.ts**：proxy `/api` 加 `ws: true`（dev 环境 WS 转发）
6. **降级**：WS 连接失败自动重连，功能不受影响（SSE 主通道仍在）

### 测试（server.test.ts 扩展）
- ws 客户端连接 `/api/v1/ws` 成功
- chat 事件同时出现在 WS（广播）
- 多客户端广播、断线清理
- 心跳/异常连接不崩溃

### 验收
- Web 两个标签页：改标题/新会话，另一页实时刷新
- chat 任务事件（tool_call 等）经 WS 广播可达
- SSE 回归测试全绿（保留路径）

---

## 实施顺序

1. **0** 测试 fixture 化（独立，先恢复全绿）
2. **1** CI：cross-env 化 scripts → platform guard → ci.yml（依赖 0）
3. **2a** 沙箱（独立，可与 1 并行）
4. **2b** WebSocket（最大，最后）
5. 文档 + 发布：README（安全章节/Web 架构/徽章）+ AGENTS.md + **版本 0.3.0** + CHANGELOG 0.3.0 段 → 提交 → 推送双远程（GitHub SSH 443 / Gitee）

## 风险与对策

| 风险 | 对策 |
|---|---|
| 2b 改动面大（server+web+vite） | SSE 保留为降级路径；分步提交；web:build 验证 |
| 沙箱默认策略误伤实机 | 默认仅 stripSecretEnv 开启；cwd 约束仅拦越界；实机回归验证 |
| CI windows runner 装 better-sqlite3 | GitHub Actions 可达 npm registry，有 prebuilt；npm ci 验证 |
| cross-env 引入新依赖 | 常用稳定 devDep，npm ci 安装验证 |

## 验收总纲
- `npm test` 全绿（现有 332 + 新增 sandbox/ws/fixture 用例）
- `npm run lint` / `npm run build` / `npm run web:build` 全过
- GitHub Actions 双平台 CI 绿
- 实机（Windows）：沙箱拦截越界命令；Web 多标签同步
- 双远程推送完成，工作树干净
