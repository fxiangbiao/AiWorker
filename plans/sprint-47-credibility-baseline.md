# Sprint 47 — 可信基线（CI / Web 静态检查 / 权限规则化 / Windows 最小沙箱）

> 依据：`plans/roadmap-next.md` P0-1～P0-4、P0-7；`docs/主流Agent产品对比分析报告.md` 第四章差距 4.1-#1、4.1-#2、4.2-#6、4.2-#7
> 版本：1.4.0 → 1.5.0（待提交时收口）

---

## 一、目标

把 AiWorker 的"信任底线"补齐到可被外部工具与人信任的程度：

1. **任何改动都有 CI 门禁**（后端 + Web 双向），不再依赖本地手动跑测试；
2. **权限可表达、可解释**：从"三档模式"升级到 `Tool(specifier)` 级规则（deny → ask → allow），支持通配、永不自动批准清单、受保护路径；
3. **命令执行有写边界**：`terminal_exec` 的写入目标被约束在可写根内（Windows 无内核级沙箱，如实标注为启发式防线）；
4. **测试可重复**：消除既有依赖 mtime/readdir 顺序的 flaky 用例。

---

## 二、设计

### 2.1 权限规则（`config/permissions.json`）

```json
{
  "rules": [
    { "tool": "terminal_exec", "match": "*git push --force*", "action": "deny" },
    { "tool": "fs_write", "match": "*secret*", "action": "ask" },
    { "tool": "terminal_exec", "match": "*npm test*", "action": "allow" }
  ],
  "never_auto_approve": ["fs_write"],
  "protected_paths": [".git", ".ssh", ".aws", ".kube", ".claude", ".npmrc", ".env", "id_rsa"]
}
```

**求值语义**（实现于 `src/security/permission-model.ts` + `approval-service.ts`）：

| 规则 | 语义 |
|---|---|
| 匹配 | `tool` 为 glob（`fs_*`、`mcp_*`、`*`，大小写不敏感）；`match` 为对"目标串"的 glob，缺省表示该工具全命中 |
| 目标串 | fs 类 = 解析后的绝对路径；`terminal_exec`/`terminal_session` = 命令文本；其余 = 参数 JSON（`extractTarget()`） |
| 优先级 | 命中多条时 **deny > ask > allow**；同类取配置中首条 |
| deny | 任何模式下直接拒绝（`checkPermission` 阶段即拦截，`checkConfirmation` 双保险） |
| ask | 强制走确认通道（auto 模式也确认）；无确认通道 → fail-closed 拒绝 |
| allow | 免确认；**不能绕过只读模式**（ask 模式下写工具仍被拦），**不能覆盖** `never_auto_approve` 与受保护路径 |
| never_auto_approve | 列为"永不自动批准"的工具在任何模式下都必须确认，无通道即拒绝 |
| protected_paths | 命中片段即对写入类工具（`fs_write` / `fs_edit` / `terminal_exec`）强制确认 |
| plan 模式 | 保持"全确认"语义，规则不改变它 |

默认 `config/permissions.json` 的 `rules` 与 `never_auto_approve` 为**空数组**（不改变既有行为），`protected_paths` 默认内置敏感路径清单。

### 2.2 Windows 最小沙箱（`src/security/sandbox.ts`）

在既有「cwd 越界 fail-closed + 命令黑名单 + 敏感环境变量清理」之上叠加**可写根约束**：

- 解析重定向目标（`>` / `>>`，忽略 `2>&1`、`>nul`、`/dev/null`、`$null`）；
- 解析写入类命令后的首个路径 token（`Set-Content` / `Out-File` / `New-Item` / `Remove-Item` / `Copy-Item` / `Move-Item` / `del` / `rmdir` / `mkdir` / `copy` / `move` / `tee` …），仅在**命令位置**（行首或 `; & | (` 之后，解释器包裹时含引号）匹配；
- 目标须落在可写根内：`allowWriteDirs` 配置优先，缺省回退工作目录；
- 含变量/通配（`$` / `%`）无法静态解析的目标 **fail-closed 拒绝**，提示改用 `fs_write`；
- 伪目标与注释文本不误判（`git commit -m "copy fix"` 不触发）。

**已知局限（诚实标注）**：这是**启发式**防线，不覆盖脚本内部动态拼接的路径、不支持管道下游程序的写入、不做 OS 级隔离（bwrap / restricted token）。它与 danger-detector、路径校验、超时、输出截断共同构成多层防御，而不是沙箱替代品。

### 2.3 CI 门禁（`.github/workflows/ci.yml`）

两个并行 job：

- `backend`：`npm ci` → `npm run build` → `npm run lint` → `npm test`（Node 22，ubuntu-latest）；
- `web`：`npm ci`（web/）→ `npm run check`（svelte-check）→ `npm run build`。

新增脚本：根 `check:web`、`verify`（一条命令跑全部门禁）；`web/check`。

### 2.4 Web 静态检查（svelte-check）

- 新增 `web/svelte.config.js` 修复"读不到 Svelte 配置"的系统性问题；
- 逐条修正真实类型错误（联合类型缺项、`possibly null`、接口缺字段等），**不使用 `as any` / `@ts-ignore`**，不改变运行时行为；
- 门禁阈值 `--threshold error`。

### 2.5 测试确定性

`test/hooks.test.ts` 中两个 captureDiff 用例原先共享 `snapshots/test-session` 目录并按 mtime 取"最新"快照，存在同毫秒写入导致的顺序依赖（本次因时序变化暴露）。改为**每次运行使用独立 sessionId**，断言该目录下恰好一个快照文件。

### 2.6 代码审查跟进（同批次加固）

自查发现的"实现弱于承诺"问题，随本批次一并修复：

1. **沙箱写入目标**：原实现只取"命令位置后的第一个非开关 token"，被三类常见写法绕过——带值开关顶位（`Set-Content -Encoding utf8 <越界>`、`New-Item -ItemType Directory -Path <越界>`）、目标不在首位（`Copy-Item a.txt <越界>`）、别名与未列举程序（`rm -rf`、`ni`/`sc`/`cp`/`mv`/`ri`、`curl -o`、`robocopy`、`xcopy`、`tar -C`、`Expand-Archive`、`git clone`、`npm install --prefix`）。现改为：写入类命令/程序片段内**所有"像路径"的参数**都校验（源与目标），别名与上述程序纳入模式；引号内文本用等长掩码参与定位、回取原文取参数。
2. **重定向引号感知**：非包裹命令中引号内的 `>` 不再当作重定向（`echo "a > b"` 不误判）；解释器包裹命令（`cmd /c "echo x > …"`）仍按引号不敏感扫描，包裹内的越界重定向照样拦截。
3. **受保护路径按路径段匹配**：`.git` 只命中 `.git`（及其 `.` 前缀），不再误伤 `.gitignore` / `.gitattributes` / `.github/**`（原先在 auto 模式下会强制确认，甚至因无确认通道直接拒绝）；命令文本先按空白/标点拆候选片段再切段，`git config --file .git/config` 依旧命中；配置补 `.envrc`。
4. **规则加载校验**：`tool` 非空串、`action ∈ deny|ask|allow`、`match` 为字符串或缺省，否则丢弃并 `warn`——避免 `"action": "denyy"` 这类拼写错误让 deny 规则**静默失效**（fail-open）。
5. **`allow` 免确认显式限定 auto 模式**：不再依赖 `permissionCheck` 钩子先于 `confirmHighRisk` 执行的隐式顺序。
6. **行为变更（需知悉）**：写入根约束现会**先于**危险检测拦截越界写入，`rm -rf /` 这类命令由"确认后可执行"变为"任何模式直接拒绝并提示写入越界"；需要终端写入项目根之外时，请在 `config/sandbox.json` 的 `allowWriteDirs` 中显式声明。

---

## 三、验收

| 项 | 结果 |
|---|---|
| 后端 `tsc` | ✅ |
| `eslint src/` | ✅ |
| 全量测试 | ✅ **862 / 59 文件**（824 → 862：新增权限规则 14 例、沙箱写入 12 例、文档资源 11 例、越界写入提前拦截 1 例） |
| `web:build` | ✅ |
| `svelte-check --threshold error` | ✅ 62 错 → **0 错**（65 warnings 不阻断；修复 31 个系统性配置问题 + 约 28 个真实类型错误） |
| `npm run verify` | ✅ exit 0（build → lint → test → web:build → check:web 一条命令全绿） |
| 行为回归 | ✅ 既有 approval-service / hooks / tools / terminal-session 用例全部通过 |
| 沙箱反例 | ✅ 12 例：带值开关顶位、copy/move 目标、别名、下载/解压/克隆、引号感知、越界拒绝、目录内放行 |
| 顺带修复 | ✅ ①`FileDiffPanel.sessionTitle` 使用 `DiffSession` 上不存在的 `id`（无 summary 时会 `undefined.slice` 抛错）→ 改用 `sessionId`；②两处 captureDiff 用例的快照竞态；③`asset-url` 的 `/files` 前缀无边界判断；④`DocPreviewPanel` 行类型 `collapsed` 改为目录行可选 |

---

## 四、后续（Sprint 48）

1. headless 模式：`aiworker -p`（JSON / stream-json）+ 退出码语义；
2. 检查点与 `/rewind`：每轮快照 + 代码/对话可分恢复；
3. 权限记忆：allow-always（会话/项目级）+ `/permissions` 规则可视化与一键撤销；
4. fs 工具写路径统一走同一策略层（当前仅命令层约束）。
