# Sprint 49 — 权限闭环与路径策略单点（P1-4 + P1-7）

> 依据：`plans/roadmap-next.md` P1-4、P1-7；`docs/主流Agent产品对比分析报告.md` 差距 4.1-#1、4.1-#3
> 版本：1.6.0 → 1.7.0
> 状态：**已完成（含两轮审查修复）**（49.0～49.5 + 审查修复第一/二轮全部落地；提交前须经用户同意）
> 前置：Sprint 48 收口 P0（`plans/sprint-48-headless-checkpoint.md`），已在同文件把 P1-4、P1-7 排入 S49

---

## 一、目标

P0 让工具调用能回答"**谁允许的、按哪条规则**"；S49 补上最后两问——"**这条规则从哪来、能不能撤**"，并让"路径边界"从三套各自为政的规则收敛成一套。

1. **权限记忆（P1-4）**：确认弹窗可"本会话始终允许"；规则可持久化、可列出来源、可一键撤销；持久化动作本身进审计。
2. **路径策略单点（P1-7）**：读/写四条路径工具与命令沙箱共用同一套读根、写根、受保护路径判定，且判定对符号链接有效。

---

## 二、现状诊断（均为实测，非推测）

### 2.1 读路径没有任何边界

| 调用（auto 模式） | 审批层 | 工具层 | 结论 |
|---|---|---|---|
| `fs_read C:/Users/ALAN/.ssh/id_rsa` | 放行，**未触发确认** | 无检查 | 静默可读 |
| `fs_read <工作目录>/.env` | 放行，**未触发确认** | 无检查 | 静默可读 |
| `fs_list C:/Users/ALAN/.ssh` | 放行，**未触发确认** | 无检查 | 静默可列 |
| `fs_read D:/ALAN/secret-outside.txt` | 放行，**未触发确认** | 无检查 | 静默可读 |

实测方式：真实 `ApprovalService` + 真实 `toolRegistry.getHandler("fs_read"/"fs_list")`（`perm-probe.ts` / `fs-probe.ts`，见 §六 复现说明）。

根因：`src/security/approval-service.ts` 的受保护路径检查只对 `WRITE_TOOLS = {fs_write, fs_edit, terminal_exec}` 生效（第 170 行），读工具不在其列；`fs_read` / `fs_list` 处理器（`src/tools/builtin.ts:65`、`:386`）只做 `resolve()`，不做包含关系判定。

### 2.2 写路径有两套边界，且都可被符号链接绕过

| 调用 | 审批层 | 工具层 | 结果 |
|---|---|---|---|
| `fs_write ../outside/direct.txt` | 放行 | `relative()` 判定拦截 | 拦截成功 |
| `fs_write esc/pwned.txt`（`esc` 是指向工作目录外的符号链接） | **放行且未确认** | **放行** | **越界写入成功**（实测内容落到工作目录外） |
| `fs_write <工作目录>/.env` | 命中受保护路径 → 确认 | 放行 | 语义为"确认"，非拒绝 |
| `fs_write <allowWriteDirs 内的目录>/x.txt`（在工作目录外） | 放行 | `relative()` 判定拦截 | 与命令沙箱相反：命令能写，fs 工具不能写 |

根因：工具层用 `resolve()` 后的**词法**比较（`src/tools/builtin.ts:160-170`、`:223-233`），不解析真实路径，符号链接是指向外部的普通文件名；审批层不校验包含关系，只校验规则／受保护路径／高危模式。命令层则另有 `src/security/sandbox.ts` 的 `allowWriteDirs`（`checkWriteTargets`），与 fs 工具互不知情。

### 2.3 权限规则只能进不能出

- `PermissionModel.addRuntimeRule()`（`src/security/permission-model.ts:61`）只写内存、进程结束即失效，且注释明确"不写盘"。
- 没有任何命令或端点能列出当前生效规则及其来源，也无法撤销；`/config permission-mode` 只改默认模式（`src/commands/config.ts:29`）。
- 确认弹窗固定两个选项（`src/security/approval-service.ts:160-163`），无法表达"以后别再问了"。
- Web 侧只有模式选择与逐 Agent 的 `allowedTools/deniedTools`（`web/src/components/InputArea.svelte:137`、`AgentsPanel.svelte:291`），没有规则视图。

---

## 三、设计

### 3.1 路径策略单点 `src/security/path-policy.ts`（新增）

一个模块回答"这个路径能不能读/写、按哪条规则"，其余位置全部改为调用它：

```
checkPath(kind: "read" | "write", rawPath: string, ctx: { workingDir, dataDir, policy }): {
  action: "allow" | "ask" | "deny";
  reason: string;
  resolved: string;     // realpath 解析后的真实路径
}
```

- **判定顺序**：受保护路径 → deny 规则 → 写根／读根包含关系 → allow。
- **真实路径解析**：对已存在的父级逐级 `realpathSync`（目标文件可能尚不存在），符号链接与 junction 一并解析——这是 2.2 越界的正解；解析失败（如盘符不存在）按 deny 处理（fail-closed）。
- **根来源统一**：写根 = `sandbox.allowWriteDirs`（留空回退 `workingDir`）；读根 = 新增 `sandbox.allowReadDirs`（留空回退 `workingDir`，可通过配置放宽，不改变默认安全姿态）。
- **调用方**：`fs_read` / `fs_list` / `fs_write` / `fs_edit` 四个处理器；`sandbox.checkCommand` 复用同一写根与受保护路径判定，不再各写一份。
- **兼容**：`checkWriteTargets` 的启发式命令解析保持不变（它解决的是"命令里哪个 token 是路径"，不是"路径是否越界"），只把最终的根集合与受保护路径判定换成 path-policy 提供。

### 3.2 权限记忆（P1-4）

**规则来源分层**（`PermissionModel` 内部保留数组顺序，仅新增来源标注）：

| 层 | 来源 | 生命周期 | 可撤销 |
|---|---|---|---|
| 内置 | 代码内建默认 | 永久 | 否 |
| 项目 | `config/permissions.json` 的 `rules`（已跟踪，用户可见可提交） | 跨进程 | 是（写回文件） |
| 会话 | 内存（`addRuntimeRule` 现状） | 进程内 | 是（`/permissions revoke`） |

- 求值优先级不变（deny > ask > allow）；来源只影响展示与撤销范围，不影响判定。
- **持久化写入**：`saveRule(rule, scope)` 复用 `isUsableRule` 校验 → 临时文件 + `rename` 原子替换 → 重载 `PermissionModel`；解析失败或校验不通过一律拒绝写入并报原因，不半写。
- **不可持久化的情形**（保持 fail-closed，写入时即拒绝并说明）：规则会覆盖 `never_auto_approve` 清单、命中受保护路径、或试图把 deny 降级为 allow。
- **审计**：新增 `permission:rule-added` / `permission:rule-removed` 审计事件（复用 `auditLogger` 与既有 `/audit` 端点），规则变更与工具调用共享同一条时间线。

### 3.3 确认通道扩展（第三选项）

- `ApprovalService.confirm()` 的选项列表按场景生成：`允许` / `本会话始终允许` / `拒绝`（仅"因规则或高危而确认"的场景提供第三项；plan 模式的全量确认不提供，避免误存）。
- 返回值 `allow_session` → 落一条**会话级**规则；Web 端 `ConfirmCard.svelte` 已按 `options` 数组渲染（`ChatPanel.svelte:558`），只需补一个按钮（可能再加"始终允许（写入项目配置）"，见 §七 分叉 2）。
- 无确认通道（headless / 后台任务）时行为不变：直接拒绝，不产生任何规则。

### 3.4 CLI 与 Web 视图

- 新增 `/permissions`（`src/commands/permissions.ts`）：

| 用法 | 说明 |
|---|---|
| `/permissions` | 列出生效规则：动作、工具、目标、**来源** |
| `/permissions allow <Tool>[(<glob>)]` | 写入项目级 allow 规则 |
| `/permissions deny\|ask <Tool>[(<glob>)]` | 写入项目级 deny／ask 规则 |
| `/permissions revoke <序号>` | 撤销一条（按来源分别落盘或清内存） |
| `/permissions reset` | 清空项目级规则（会话级一并清） |

- 新增端点：`GET /api/v1/permissions`（列表）、`POST`（增删）。Web 在右侧栏新增「权限」Tab（与「回滚」并列），内容为规则表 + 来源徽标 + 撤销按钮；模式选择仍在输入区不变。

---

## 四、任务拆分（每步独立可验证）

| 步 | 内容 | 产物 |
|---|---|---|
| 49.0 | 路径策略单点 + 真实文件系统单测（含符号链接反例） | `src/security/path-policy.ts`、`test/path-policy.test.ts` |
| 49.1 | 四个 fs 处理器与命令沙箱接入；读根／写根／受保护路径行为对齐 | `src/tools/builtin.ts`、`src/security/sandbox.ts`、扩充既有断言 |
| 49.2 | 规则来源分层 + 原子持久化 + 校验与拒绝原因 | `src/security/permission-model.ts` |
| 49.3 | 确认通道第三选项 + 审计事件 | `src/security/approval-service.ts`、`src/hooks/confirm-channel.ts` |
| 49.4 | `/permissions` 命令 + 端点 + Web「权限」Tab | `src/commands/permissions.ts`、`src/server.ts`、`web/src/components/PermissionsPanel.svelte` |
| 49.5 | 文档（README 权限章节并入新表）、CHANGELOG、版本 1.7.0、`npm run verify` + CI 绿 | — |

依赖顺序：49.0 → 49.1（路径策略落地）与 49.2 → 49.3 → 49.4（权限闭环）可并行推进，但 49.1 先行，因为 49.4 的规则目标串匹配依赖路径解析语义已统一。

---

## 五、验收标准与反例清单

门禁：`npm run verify`（build / lint / test / web:build / svelte-check）一条命令全绿，CI 双 job 绿，既有 909 例无回归。

**必须全绿的反例（每条一个用例）**：

1. `fs_write` 经符号链接仍被拦截（工作目录外）；
2. `fs_read` / `fs_list` 绝对路径越出读根被拒，且拒绝原因是策略而非"文件不存在"；
3. `sandbox.allowWriteDirs` 内的路径：命令写放行 **且** fs_write 同样放行（当前相反，属修正）；
4. 受保护路径（`.env` / `.ssh` / `.git`）读与写均需确认；
5. 「本会话始终允许」后同一目标不再确认，`/permissions revoke` 之后恢复确认；
6. deny 规则不可被 allow-always、`--yes`、项目级 allow 覆盖；
7. `config/permissions.json` 非法 JSON／非法规则时写入被拒且原文件不变（原子性）；
8. headless（无确认通道）下"始终允许"不可达，仍是 fail-closed 拒绝；
9. 规则变更写入审计，`/audit` 可查。

---

## 六、实施结果与复现说明

### 6.1 落地情况（49.0～49.5）

| 步 | 产物 |
|---|---|
| 49.0 | `src/security/path-policy.ts`（`resolveRealPath` 逐级真实路径解析、`resolveRoots`、`evaluatePath`、策略注入）+ `test/path-policy.test.ts`（11 例，含 junction 越界与「不存在的尾段位于链接之下」反例） |
| 49.1 | `src/tools/builtin.ts` 四个 fs 处理器接入（`denyOutOfScope`）；`src/security/sandbox.ts` 根解析与包含判定改走 path-policy、命令写入目标同样解析真实路径；`src/security/approval-service.ts` 受保护路径对读工具生效（`PROTECTED_TOOLS`）；`config/sandbox.json` 新增 `allowReadDirs` |
| 49.2 | `src/security/permission-memory.ts`（两级来源 + 原子写回 + 校验拒绝 + 审计）；`PermissionModel` 增加 `addRule/listRules/removeRule/removeRulesBySource/validateRule`；`src/types.ts` 增加 `PermissionRuleSource`/`SourcedPermissionRule`/`PermissionRuleChange` |
| 49.3 | `ApprovalService` 确认选项按场景生成、「始终允许」写规则、记忆失败仍放行并回报原因；`permissionMemory` 经 bootstrap / handlers 注入 |
| 49.4 | `src/commands/permissions.ts` + 注册表；`GET/POST /api/v1/permissions`；`web/src/components/PermissionsPanel.svelte` + 右侧栏「权限」Tab |
| 49.5 | README（权限记忆与路径边界两节 + 命令/端点/Tab 行）、CHANGELOG 1.7.0、`package.json` 1.7.0、AGENTS.md CLI 列表 |

### 6.2 与原设计的三处偏差（均已落到代码注释与文档）

1. **`evaluatePath` 返回 `{ allowed, resolved, reason }` 而非三态 `allow|ask|deny`**：受保护路径的"需确认"语义留在审批层（`PermissionModel.protectedPaths`），路径策略只做**包含关系**的硬拒绝。两层职责因此不重叠：策略层答"越界没有"，审批层答"要不要问"。
2. **fs 边界不受 `sandbox.enabled` 影响**：`sandbox.json` 的开关历史上只作用于命令层；若让 `enabled: false` 一并关掉文件读写边界，此前把该开关关掉的用户会**静默失去**新加的读保护。故 fs 四件套始终按读根/写根判定，需要更大范围请显式配置根。
3. **「始终允许」只出现在 auto 模式的高危确认上**：规则 `ask`、`never_auto_approve`、受保护路径三次求值都不会被 `allow` 覆盖（deny > ask > allow 且后两者不可被 allow 越过），在这些场景提供"记住"选项是**无效承诺**，故不提供。

### 6.3 诊断脚本的可重跑版本

实施时的临时探测脚本（`%TEMP%\perm-probe.ts` / `fs-probe.ts` / `sym-approval-probe.ts`）已转化为正式用例：

- `test/tools.test.ts` → 「20. fs 四件套路径边界（Sprint 49）」6 例：越界读/写、`../` 与绝对路径、junction 越界、读根写根互不影响、空路径 fail-closed；
- `test/sandbox.test.ts` → 「20. 路径策略与命令沙箱同源」3 例：命令写入经链接越界、`allowReadDirs` 不影响写约束、配置解析；
- `test/approval-service.test.ts` → 受保护路径读 4 例 + 确认弹窗「始终允许」6 例；
- `test/permission-memory.test.ts` → 规则来源/原子性/撤销/审计 10 例 + HTTP 端点 2 例；
- `test/path-policy.test.ts` → 11 例；
- `test/cli-commands.test.ts` → `/permissions` 命令 7 例。

符号链接用例：环境无法创建目录链接时以 `describe.skipIf` **显式跳过**（vitest 报 skipped，不静默通过）；本机与 CI 均可创建，用例实际执行。

### 6.4 门禁与一处观察

- `npm run verify`（build / lint / test / web:build / check:web）一条命令通过（exit 0）；全量 **961 例 / 65 文件** 全绿，`svelte-check` 0 错误 65 warnings（与基线持平）。
- **真实端到端验证**（`dist/` 产物 + 真实模型 + 真实工具链，非 mock）：
  | 场景 | 结果 |
  |---|---|
  | `aiworker --help`（dist 装配与 ESM 后缀） | exit 0，用法正常输出 |
  | `-p "调用 fs_read 读取 inside.txt" --mode auto --dir <临时项目>` | exit 0，`tool_result success`，回答内容 = 文件内容 |
  | `-p "调用 fs_read 读取 <工作目录外绝对路径>" --mode auto` | `tool_result success:false`，错误为「读取越界被路径策略拦截…（可在 config/sandbox.json 的 allowReadDirs 放宽读取范围）」，**文件内容未进入模型上下文**（stream-json 可复核） |
  | 同上，临时把 `allowReadDirs` 指向该目录后重跑 | 读取成功（证明放宽开关真实生效）；验证后已把 `config/sandbox.json` 恢复为 `[]`（`git diff` 只剩新增的 `allowReadDirs` 一行） |
- **观察（未定性为本次引入）**：改动过程中有一次全量并行运行出现 `test/memory.test.ts` 1 例失败，随后 6 次全量运行与 15 次单文件运行均通过（单文件 16/16），未能复现，故未做处理也未声称已修复。该文件内的候选嫌疑是时间相关的「searchEpisodic 时间衰减排序」与「getRecentTurnLogs 回退到最近会话」；如是并行负载下的竞态，属 P0-7「测试确定性」的余量，建议后续单独排查（不在本 Sprint 范围内）。
- 提示：PowerShell 里用 `2>$null | Select-Object` 串联 node 时会出现 `[exit code: 1]` 假象（管道退出码），显式重定向到文件后实测 `node exit=0`。

---

## 七、决策记录（2026-09 已确认）

1. **范围**：只做 **P1-4 + P1-7**。P1-1 后台子智能体留到 S50——子智能体没有确认通道，只能靠"预先授予的规则"干活，P1-4 是其前置。
2. **持久化位置**：默认写**项目级** `config/permissions.json` 的 `rules`（用户可见、可 review、可提交），确认弹窗同时提供更轻的「仅本会话」选项；会话级规则不落盘。
3. **读边界语义**：`fs_read` / `fs_list` **默认收紧到读根内**（读根 = `sandbox.allowReadDirs`，留空回退工作目录），需要越界读时在 `config/sandbox.json` 显式放宽；这是行为变更，README 需标注。

未单独提问、按既有偏好默认执行的两项（如需变更请在实施前指出）：

- **Web 面板本轮同做**：49.4 包含「权限」Tab（规则表 + 来源徽标 + 撤销），与「回滚」Tab 并列。
- **版本号**：1.6.0 → 1.7.0，CHANGELOG 记为 Sprint 49。

---

## 八、代码审查修复

三方独立对抗式审查（路径策略面 / 权限记忆与审批面 / CLI-API-Web 面）+ 自查共发现 40 余项问题，其中高危 8 项。分两轮修，**均不提交**。

### 8.1 第一轮（49.1 边界与撤销，已完成）

| 缺陷 | 危害 | 修法 | 反例用例 |
|---|---|---|---|
| `resolveRealPath` 把"存在但解析不出"当成"不存在" | 悬空符号链接 + 一次 `fs_write` 即可写到根外（实测） | 从盘根**逐组件**解析；悬空/环/权限/超限一律返回"无法解析"并按拒绝 | `test/path-policy.test.ts` 悬空链接与 45 层用例、`test/tools.test.ts` 悬空链接 handler 用例 |
| 剥层上限 40 用尽后退回词法 | 41+ 层即越界（实测越界成功） | 同上（按组件数上限，超限即拒绝） | 同上 |
| 审批层用词法路径、路径策略用真实路径 | 工作目录内 junction 绕过 deny 规则与受保护路径（实测改写 `.git/config`） | 审批层 fs 目标先 `resolveRealPath` 再匹配 | `test/approval-service.test.ts` junction 绕 deny / 受保护目录用例 |
| `allow` 命中即短路危险检测 | 一条通配 allow（含跨源 HTTP 写 `tool:"*"`）永久关闭高危确认 | 危险工具仍跑检测；仅 `exact` 规则与 `--yes` 进程内开关豁免；`tool:"*"` 无 match 拒绝写入 | "非精确 allow 不再短路危险检测"、"跨源 POST tool=* 被拒" |
| 记忆规则把命令文本当 glob | 授权范围被 `*` 放大（实测 `rm -rf build/../../../important` 被放行） | 弹窗规则带 `exact: true`，字面精确匹配 | "含通配的近似命令仍要确认" |
| 撤销"先写盘再改内存" | 文件损坏时"可撤销"是假的（规则继续生效） | 内存先撤、落盘失败仅 warning | "文件损坏时撤销与重置仍然生效" |
| 重复规则撤销不对称 | 盘上删净、内存仍留一条 | `add` 去重 + `removeRule` 删净同形 | "重复 add 去重；撤销后盘上与内存一致" |
| 伪造 `allow_project` | plan 模式确认抛 `TypeError`（`remember!` 断言） | `confirmResponse` 校验选项归属；服务层未提供记忆选项即拒绝 | "伪造的 allow_project → 拒绝且不崩溃" |
| 确认选项顺序插入中间 | 老习惯输入 `2`（原"拒绝"）变成持久化授权 | 固定 `1 允许 / 2 拒绝 / 3 项目级 / 4 会话级` | 选项顺序断言 |
| `terminal_session` 未纳入 | 读 `.ssh/id_rsa`、`rm -rf /` 零确认 | 与 `terminal_exec` 同等对待 | "terminal_session 纳入受保护路径与危险检测" |
| 命令层 `..` 词法折叠 | POSIX 上 `link\..\x` 是真实逃逸路径 | 按原文拼接 + 组件级解析；`~` 一并 fail-closed | `test/path-policy.test.ts` link\.. 用例、命令层判定实测 |
| `isInsideDir` 误伤 `..data` | 合法文件名被拒 | `rel === ".." || rel.startsWith(".." + sep)` | "`..` 开头的合法文件名不被误判越界" |
| 配置→fs 接线零覆盖 | 变异测试：读写根接反仍 53/53 全绿 | 加 `setSandboxConfigPath` 注入缝 + 真实配置文件端到端用例 | "config/sandbox.json → fs 工具接线"（已用变异复验：现在会失败） |

验收：`npm run verify` exit 0，**975 例 / 65 文件**全绿，`svelte-check` 0 错误；四个原始探针脚本（悬空链接 / 45 层 / junction 绕 deny / 伪造值 / 跨源 allow-all / 损坏文件撤销 / 选项顺序 / terminal_session）全部由"可利用"变为"被拦"。

### 8.2 第二轮（49.2 权限面收口，已完成）

四项语义决策（用户 2026-09-12 选定）：①Origin/Sec-Fetch-Site 校验 + 进程内 token；②规则继续写 `config/permissions.json`；③"项目级"跟随 `--dir`；④按 mtime 懒重载。

| 缺陷 | 危害 | 修法 | 证据 |
|---|---|---|---|
| 写接口无来源校验 | 任意网页可持久化 `tool:"*"` allow → 危险命令永久零确认（实测） | 跨站校验（`Sec-Fetch-Site: cross-site` 或 `Origin`≠`Host` → 403）+ 进程 token（`X-AiWorker-Token`，缺/错 → 401）；token 注入 `index.html` 且该响应去掉 `ACAO:*` | 端到端冒烟：403 / 401 / 200 全绿；`GET /status` 不含 token |
| 规则写入启动目录配置 | 实测跨源请求把规则写进**被 git 跟踪**的仓库 `config/permissions.json`（`git checkout` 会静默回滚） | 写入侧始终跟随 `--dir`：不存在则按模板创建（含基础策略），同名"别人的"文件拒绝覆盖 | 冒烟：`configPath === <--dir>/config/permissions.json`，仓库配置 `git status` 干净 |
| 配置缺失/损坏即清空保护 | `protected_paths`/`never_auto_approve` 变空（fail-open） | 回落到内置受保护路径清单并告警 | 单测 + 冒烟 |
| 跨进程不生效 | CLI 写的 deny 对运行中的 server 无效 | 判定前按 mtime/size 懒重载；不可读时保留当前规则并告警 | 单测 + 冒烟（外部改写后 GET 立即反映） |
| 审计答不出"谁" | 规则事件 `agent_id: system`、`session_id: ""`；且 `queryRecent` 返回 SQL 行（`agent_id`）却按 `agentId` 读，审计面板会话列恒空 | 传 actor（confirm 记会话、CLI 记用户）+ `AuditLog` 行映射归一 | 单测断言 `entry.agentId/sessionId` |
| 后台任务白等 30s | `job-runner` 只是"不注册"通道，实际回落到 stdin 提示，且可在提示里选持久化授权 | 显式安装"立即拒绝"provider（确认与提问），结束恢复 | 单测：任务期间 confirm/ask 立即返回 null，结束后恢复 |
| 保留设备名/ADS 假成功 | `fs_write("NUL")` 回报"已写入文件" | 路径策略拒绝设备名与 `a.txt:stream` | 单测（win32） |
| 端点细节 | 非法 `scope` 静默降级、`"Project"` 退化为"不限来源"、`?x=1` 404 | 严格 400 + 路由带查询串 | 单测 |
| 规则顺序不稳定 | 新增项目规则 unshift 到最前，重载后却在会话级之后 | `addRule` 固定"会话级在前、项目级在后" | 单测 |
| 写入副作用 | 无 fsync、崩溃遗留临时文件、行尾被改成 LF、权限位丢失 | fsync + 清理超 1h 临时文件 + 保留行尾/尾换行/权限位 | 单测（CRLF/BOM/权限位） |
| Web 面板 | 不显示 warning、索引 key、撤销无 in-flight | warning 展示 + 稳定 key + 禁用按钮 | svelte-check 0 错误 |

**仍未处理（留待后续，均已在文档/代码中标注）**：其余既有写接口（`/config`、`/pkg/import`、`/apps` 等）沿用原有信任模型未收紧（应用沙箱 iframe 的 `Origin: null` 是原因之一，需单独设计）；本机其他进程对配置文件的直接读写不在防护范围（同一信任边界）；`config/permissions.json` 仍为 git 跟踪文件，用户若 `git checkout` 会回滚规则（写入侧已不再碰启动目录配置，项目配置才会承载规则）。

### 8.3 第三轮（49.3 测试在受限机器上的硬失败，已完成）

**触发**：用户在本机跑 `npm test` 报 2 例 `EPERM: operation not permitted, symlink`。诊断结论：该机器能建 junction（不需要特权），但**建不了文件符号链接**（Windows 无开发者模式/管理员）；而我的进程有权限，所以同一份代码在我这儿绿、在用户那儿红——**测试缺陷，不是产品缺陷**（产品对悬空链接的判定本身正确）。

| 缺陷 | 危害 | 修法 | 证据 |
|---|---|---|---|
| 用 `"file"` 建悬空链接的 2 处用例（`path-policy` / `tools`） | 无特权机器上硬失败，门禁无法通过（用户实测 2 例红） | 悬空链接统一走 `makeDanglingLink`（Windows 用 junction，免特权）；能力探测进 `test/helpers.ts` | 本机 989 全绿；`AIW_NO_LINKS=1` 全量 978 通过 / 11 跳过、exit 0 |
| 同类隐患：`sandbox` / `approval-service` 里 3 处 junction 用例"建不出就 `expect.fail`" | 无链接权限的机器上同样变红 | 改为能力探测 + `it.skipIf` | 同上（这 3 处在 `AIW_NO_LINKS=1` 下计入 skipped） |
| 受限机器上 fail-closed 覆盖消失 | 整条"解析失败一律拒绝"若随链接一起跳过，受限机器就没覆盖 | 拆成**组件数超限**（600 层不存在组件，零链接依赖，任何机器都跑）与**悬空链接 + 链接环**（探测后跳过） | 探测失败时前者照常执行并断言 `无法解析` |
| 无法复现受限环境 | 以后同类问题只能等用户报 | `AIW_NO_LINKS=1`（无任何链接能力）/ `AIW_NO_FILE_LINKS=1`（仅文件符号链接失败 = 用户机器）强制对应创建失败（写进 `AGENTS.md` 测试约定） | `AIW_NO_LINKS=1` → 978 通过 / 11 跳过；`AIW_NO_FILE_LINKS=1` → 989 通过 / 0 跳过；均 exit 0 |

**说明**：本轮只改测试基建与文档，未改产品代码；`989 例 / 65 文件`（较第二轮多 2 例，来自 fail-closed 用例拆分与新增链接环断言）。判定"是测试缺陷而非产品缺陷"的依据：`resolveRealPath` 对悬空链接本就返回 `null` 并按拒绝处理（`test/path-policy.test.ts` 的组件超限用例与端到端探针在受限机器上照常通过）。

---

## 九、不做（本轮防守边界）

- 不做 OS 级沙箱（bwrap／受限令牌），维持"策略化沙箱 + 诚实标注"；
- 不做角色／继承式权限体系，规则语言保持 `Tool(specifier)` glob；
- 不做按工具参数的细粒度 ACL（如"只能写 < 10KB 的文件"）；
- 不引入新存储：规则复用 `config/permissions.json`，变更复用审计日志；
- 不动 `terminal_exec` 的启发式命令解析覆盖面（脚本内部动态拼接路径仍不覆盖，维持现状与诚实标注）。

---

## 十、后续预告（S50 / S51，非本轮范围）

| Sprint | 主题 | 要点 |
|---|---|---|
| S50 | **后台子智能体（P1-1）+ 持久目标（P1-2）** | 把已有 `jobRunner`（后台跑完整 Agent 回合、fail-closed、`job/done` 广播，`src/core/job-runner.ts`）从"用户命令"升级为"智能体可调用的工具面"：`spawn_agent` / `send_message` / `list_agents` / `interrupt_agent`，子会话可续接，父会话汇总结果；目标态复用 `session_events` 事件溯源，不引入新存储 |
| S51 | 压缩与成本（P1-5）+ 会话体验（P1-6）+ 工具面取一（P1-3） | 压缩阈值可调与工具结果剪枝；会话搜索／分组／归档与 50 条上限；浏览器自动化或 Notebook 编辑二者选一 |
