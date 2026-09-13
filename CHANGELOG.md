# Changelog

## 1.8.0 (2026-09-12)

### Web 信息架构重构：设置 / 控制台分离（Sprint 50 收尾 + Sprint 51）

- **问题（用户提问：为何把「权限」放右侧面板而不是「设置」里？布局是否合理）**：`⚙` 一个模态里 13 个 tab 混装"设置 + 观测 + 资源 + 系统"，其中**只有 1 个真写配置**；而**会写文件**的「权限」却挂在右栏与"产物/应用"并列；更要命的是三个安全面**在 Web 上完全看不到**——沙箱目录（`config/sandbox.json` 的 `allowDirs/allowWriteDirs/allowReadDirs/denyCommands/stripSecretEnv`）此前**没有任何 HTTP 端点**、`protected_paths`、`never_auto_approve` 只能手改文件，改错没有反馈。另外"模型配置"与"设备"两处重复展示同一件事，且图片被拒时的错误提示指向了一个**并不存在**的路径「设置→设备→模型能力」
- **拆分原则**：**设置 = 我改它**（会写配置、改变行为）；**控制台 = 我看它**（观测系统、以只读为主）
- **设置（新面板，5 个 tab）**：模型（模型选择 / 温度 / max-tokens / 添加模型 + 模型能力卡与「检测图片能力」实测）、安全（权限规则 + 受保护路径 + 永不自动批准 + 命令黑名单 + 敏感环境变量清理 + 当前模式只读）、工作区（工作目录 + 沙箱的三个根 + 目录选择器）、交互（思考展示 / 技能自动沉淀 / 主题）、关于（版本 / 数据目录 / 存储 / 运行时）
- **控制台（原系统面板）**：左导航按 **观测**（上下文·轨迹·审计·进化）/ **资源**（智能体·技能·MCP·插件·应用·进程·调度）/ **系统**（设备与运行时）分组；`配置` tab 整体迁出，`设备` tab 去掉模型能力卡的**编辑入口**（改为只读快照 + 指引到设置），其余 11 个 tab **一行未改**
- **右栏 3 → 2 Tab**：产物 / 应用；「权限」迁入 设置→安全。发现性补偿：底部状态栏新增**权限模式徽章**（显示模式与项目级规则条数），一点直达 设置→安全

### 新增可写面（每一条都带写入门 / 原子写 / 生效时机）

- **`GET/POST /api/v1/sandbox`（新增）**：沙箱配置的读写面。GET 同时回带**读路径**与**写路径**、以及 `effective`（留空的根按工作目录回退后的**真正生效范围**，避免用户以为"空着 = 不限制"）；POST 部分更新语义，校验拒绝未知键（拼错 `allowWriteDir` 会被静默忽略 → 用户以为已放开写入）、非布尔、**相对路径**（浏览器不知道服务端 cwd，猜出来的范围没意义）、空条目与多行命令。**写路径始终跟随 `--dir`**（与权限配置一致）：读取允许回落到安装目录配置，写入绝不落到安装包
- **`/api/v1/permissions` 扩展**：GET 新增 `protectedPaths`（`fromConfig` / `defaults` / `effective`）、`neverAutoApprove`、`mode`；POST 新增 `set-protected-paths` / `set-never-auto-approve`。**移除内置基线项必须显式 `acknowledge`**——文件里的 `protected_paths` 是**整体替换**语义（`bootstrap` 用 `?? DEFAULT_PROTECTED_PATHS`），"少传一条"就等于静默丢掉一层保护，因此这道确认放在**服务端强制**（而不是只靠前端弹窗），前端再用生效清单回填草稿
- **`PermissionModel` 新增 `setProtectedPaths` / `setNeverAutoApprove`**：清单原本只在构造时读入，Web 改完文件若不重启就是"看起来改了、其实没生效"；归一化规则与构造函数逐字一致（反斜杠转正斜杠 + 小写），避免同一份配置因入口不同而判定不同
- **`POST /api/v1/config` 补上写入门**（跨站 403 → 缺 token 401 → 参数 400）：此前它是**无门写面**，而设置页的模型与交互两组都要写它。已核实调用方只有 Web 自身（`app-bridge` 只走 `/apps/:id/bridge`），收口不打断应用；`SystemPanel` 的旧调用同步补 token
- **生效时机（逐条核实，不是推测）**：沙箱配置**立即生效**（`loadSandboxPolicy()` 在每次工具调用时现读磁盘，`src/tools/builtin.ts:27/437/754`）；权限规则与两个安全清单**立即生效**（落盘后同步更新运行中的模型）；`/config` 立即生效。UI 文案与之一致，不写"重启后生效"这种含糊话

### 工程整理

- 抽出 `src/security/json-file.ts`（`readJsonObject` / `writeJsonAtomic`）：权限与沙箱两处都要"读全量 → 改一处 → 原子写回"，各写一份就是两套"保留 BOM/行尾/权限位/清理遗留临时文件"的逻辑。`permission-memory` 改为复用后行为不变（19 个既有用例全绿）
- Web 侧新增 `lib/stores/shell.svelte.ts`（设置/控制台入口与 tab 深链，避免三处各自 holds 一个 open 变量）与 `lib/stores/settings.svelte.ts`（`/config` 与 `/sandbox` 两个写面的**唯一**实现：模型与交互、安全与工作区各自读同一份，不重复 fetch/错误处理）
- `PermissionsPanel` 由"右栏 Tab"改为"设置里的 section"：**去掉自带高度与 `overflow-y:auto`**（否则与外层设置面板形成双层滚动——上一轮刚踩过）
- 修正 `src/server.ts` 的错误提示：图片输入被拒时指向实际存在的「设置→模型→模型能力」
- **测试**：新增 `test/settings-api.test.ts`（10 例：沙箱读写与三类校验、写路径跟随 `--dir`、未知键拒绝、安全清单的确认机制与**立即生效**、`/sandbox` 与 `/permissions` 的三道门、`/config` 收口）；`test/server.test.ts` 的 `/config` 两例补 token 并加门断言。全量 **1036 例 / 68 文件**全绿，`svelte-check` 0 错
- **明确不做**（写进 `plans/web-ia-restructure.md`）：不加权限模式的运行时切换（现无端点，模式属启动时决策，本次只读展示）；不给零调用方的死配置 `allowed_dirs` 做 UI；不合并"应用"与"应用预览"；不重写 `SystemPanel`（只搬不动）

## 1.7.0 (2026-09-12)

### 权限闭环与路径策略单点（Sprint 49：P1-4 + P1-7）

- **路径策略单点**（`src/security/path-policy.ts`）：一处回答"这个路径能不能读/写"——读根（`allowReadDirs`，留空回退工作目录）、写根（`allowWriteDirs`）、**组件级真实路径解析**、开关与 fail-closed。命令沙箱（`terminal_exec` / `terminal_session`）与 fs 四件套共用同一套根解析与包含判定，不再各写一份
- **修复两个实测缺陷**（先复现再修）：① `fs_read` / `fs_list` 此前**没有任何越界检查**，auto 模式下可静默读 `~/.ssh/id_rsa`、`.env` 与工作目录外任意文件；② `fs_write` / `fs_edit` 的越界判定是 `resolve()` 后的**词法**比较，工作目录内指向外部的符号链接/junction 可绕过（实测写入落在工作目录外，且审批层同样放行）——现按真实路径判定并拦截
- **读边界收紧（行为变更）**：`fs_read` / `fs_list` 默认限制在工作目录内，拒绝原因是路径策略（并提示 `allowReadDirs`），需要越界读时在 `config/sandbox.json` 显式放宽；fs 读写边界**始终生效**，`sandbox.enabled: false` 只关闭命令层约束
- **受保护路径对读同样生效**：`protected_paths`（`.env` / `.ssh` / `.git` / `id_rsa` 等）此前只对写入类工具强制确认，读 `.ssh/id_rsa` 在 auto/ask 模式下静默放行；现对 `fs_read` / `fs_list` / `fs_write` / `fs_edit` / `terminal_exec` / `terminal_session` 一律生效，无确认通道时拒绝
- **权限记忆**（`src/security/permission-memory.ts`）：规则分**项目级**（`config/permissions.json` 的 `rules`，原子替换：临时文件 + `rename`，保留 BOM、其他字段与无法识别的条目）与**会话级**（内存，重启失效）；`PermissionModel` 规则带来源标注
- **「始终允许」落进确认弹窗**：auto 模式的高危确认提供「始终允许（写入项目配置）」与「本会话始终允许」，选项顺序固定为 `1 允许 / 2 拒绝 / 3 项目级 / 4 会话级`（前两位不随功能变动，避免老习惯把"2"当成拒绝却拿到授权）；生成的规则带 `exact: true` 按**字面精确匹配**，撤销后立即恢复询问；规则 `ask`、`never_auto_approve`、受保护路径按设计每次都问，**不提供记忆选项**（提供也无效，属诚实性而非疏漏）
- **写入前校验与 fail-closed**：格式非法、`never_auto_approve` 清单内工具写成 `allow`、`allow` 目标触及受保护路径（按路径段判定，`.gitignore` / `.github/*` 不再误伤）、`tool: "*"` 且无 `match` 的全局 allow → 拒绝并回显原因；配置文件不是合法 JSON / 顶层非对象 / 文件缺失 → 一律拒绝写入，原文件不动；记忆失败时仍放行本次，失败原因写审计（`permission:rule-add-failed`）。`deny` 不被任何后来添加的 `allow` 覆盖（求值仍 deny > ask > allow）
- **撤销语义**：撤销 / 重置**先改内存再落盘**，文件损坏或缺失时规则在当前进程也立即失效并给出"重启后会重新生效"的 warning；同形规则不重复写入，撤销时盘上与内存同时删净（此前会出现"报成功但规则仍生效"）
- **`/permissions` 命令**：无参数列出规则（动作 / 工具 / 目标 / 来源，会话级在最前即规则表顺序）；`allow|ask|deny <Tool>[(<glob>)]` 写项目级规则；`revoke <序号>` 撤销（按来源分别写回文件或清内存）；`reset` / `clear-session` 清空两级
- **HTTP 与 Web**：新增 `GET/POST /api/v1/permissions`（列出 / `add|revoke|reset|clear-session`，错误码 400/404/405/503 并回带当前清单）；Web 右侧栏新增「权限」Tab（`PermissionsPanel.svelte`）：规则表 + 来源徽标 + 新增/撤销/清空；规则变更写审计（`permission:rule-added` / `rule-removed` / `rules-reset`）
- **测试与门禁**：全量 **989 例 / 65 文件** 全绿（第一轮收口时 975），`npm run verify` 一条命令通过（exit 0），`svelte-check` 0 错误 65 warnings（与基线持平）；无链接权限的机器上 978 通过 / 11 跳过（`AIW_NO_LINKS=1` 复现）。配置→fs 工具接线用例用真实 `config/sandbox.json` 走一遍（此前的策略注入会短路配置读取，把读写根接反也测不出来——已用变异测试确认新用例能拦住）
- **诚实边界**：`sandbox.json` 仍是**策略级**防线（非 OS 级隔离）；命令沙箱不覆盖解释器脚本体内部写入、未列举程序、MCP/插件工具的文件写入；`terminal_exec` 写目标判定为启发式；本机其他进程直接改配置文件不在防护范围；`config/permissions.json` 仍是 git 跟踪文件，手工编辑后被 `git checkout` 会回滚；需要链接权限的用例按能力探测显式跳过（`AIW_NO_LINKS=1` 可复现无链接环境）

### 代码审查修复（第一轮：边界与撤销）

> 本 Sprint 的功能代码经三方独立对抗式审查 + 自查，发现并修复以下缺陷；每条都补了可复现的反例用例。

- **路径解析 fail-open（高）**：旧实现把"存在但解析不出真实路径"当成"路径不存在"逐级剥离，退化成词法判定——悬空符号链接（实测可把内容写到工作目录外）与 40+ 层路径（实测越界成功）都能绕过写根。现改为从盘根**逐组件解析**：每个存在的组件都 `realpath`，`..` 在解析之后才弹出（`link\..\x` 与内核语义一致），悬空链接 / 链接环 / 权限不足 / 组件数超限一律返回"无法解析"并按拒绝处理
- **命令层 `..` 语义（中）**：`checkWriteTargets` 先前对 token 做 `resolve()` 词法折叠，而 shell 拿到的是原文（POSIX 上是真实逃逸路径）。现按原样拼接后交给同一套组件级解析；`~`（PowerShell 主目录）与 `$`、`%` 一并 fail-closed
- **junction 绕过规则与受保护路径（高）**：审批层用词法路径判定规则与 `protected_paths`，路径策略用真实路径，二者不一致——实测工作目录内一个 junction 即可绕过 `fs_write(*.git*)` deny 规则并改写 `.git/config`。现审批层对 fs 类目标先 `realpath` 再匹配
- **allow 规则短路危险检测（高）**：`allow` 命中即免确认发生在 danger-detector 之前，一条通配 allow（含跨源 HTTP 写入的 `tool:"*"`）即可永久关闭高危确认。现危险相关工具（`terminal_exec` / `terminal_session` / `fs_write`）仍跑危险检测，只有交互产生的 `exact` 规则与 `--yes`（进程内开关，不落盘、不可从 HTTP 配置）可豁免；`tool:"*"` 且无 `match` 的规则拒绝写入
- **记忆规则被 `*` 放大（高）**：确认弹窗把命令文本原样当 glob 存，对 `rm -rf build/*` 点"始终允许"后实测还能放行 `rm -rf build/../../../important`。现弹窗生成的规则带 `exact: true`，按字面精确匹配
- **撤销语义（高/中）**：撤销 / 重置先前"先写盘再改内存"，文件损坏时返回失败但规则仍生效（"可撤销"是假的）；重复规则撤销后盘上删净、内存仍留一条。现改为内存先撤 + 落盘失败仅告警（warning 说明重启后会回来），同形规则去重、撤销时两侧同时删净
- **伪造确认值（高）**：`confirm()` 对 `remember` 用 non-null 断言且不校验返回值来源，客户端伪造 `allow_project` 可让 plan 模式的确认抛 `TypeError`。现 `confirmResponse` 校验值必须属于该次请求提供的选项，服务层未提供记忆选项时按拒绝处理；选项顺序固定为 `允许 / 拒绝 / 项目级 / 会话级`
- **`terminal_session` 未纳入保护（中）**：既不在受保护路径集合，也不走危险检测（实测读 `.ssh/id_rsa`、`rm -rf /` 零确认）。现与 `terminal_exec` 同等对待
- **`isInsideDir` 误伤（低）**：`rel.startsWith("..")` 把 `..data/f.txt` 这类合法名判为越界，现按 `..` 加分隔符精确判断
- **审计补口（低）**：记忆失败写 `permission:rule-add-failed`（`proceed=true` 时 hook 会丢弃 message，审计是唯一可靠通道）

### 代码审查修复（第二轮：权限面收口）

- **写接口的来源校验与进程 token（高）**：新增的 `POST /api/v1/permissions` 此前无来源校验——任意网页在 `--server` 运行时即可持久化规则（实测 `OPTIONS` 回 `ACAO:*`、跨源 POST 写入 `tool:"*"` allow，此后 `rm -rf /`、`shutdown /s` 全部零确认）。现写操作需通过 ①`Sec-Fetch-Site` 非 `cross-site`（缺失时回退 `Origin` 与 `Host` 比对）②请求头 `X-AiWorker-Token` 等于本进程 token；token 注入 `index.html`（该响应移除 `ACAO:*`，跨源页面读不到），并写入 `<dataDir>/server-token`、启动日志打印。`GET` 只读接口保持开放（与 `/audit`、`/status` 一致）
- **配置路径跟随 `--dir`（写入侧）**：项目级规则**始终**写到 `<--dir>/config/permissions.json`，不存在时按需创建（以启动目录配置为模板，含受保护路径等基础策略），创建后读取来源自动切到项目配置；`<--dir>` 下同名文件若不含任何权限键（别的工具的 `permissions.json`）则拒绝覆盖。**启动目录/安装目录的配置不会被 Agent 授权动作改写**——此前实测（端到端冒烟）一次跨源请求就把规则写进了仓库里被 git 跟踪的 `config/permissions.json`，`git checkout` 会静默回滚它。`config/sandbox.json` 同样按 `<--dir>` → 启动目录 → 包内的顺序解析（修复"全局安装或 `--dir` 指向别处时用户配置不生效"）
- **跨进程一致性**：按文件 `mtime`/`size` 懒重载，权限判定前自动检查——CLI 或另一个进程写入的 deny 对运行中的 server 立即生效；文件不可读时保留当前规则并告警（不静默丢 deny，也不静默清空）
- **配置缺失/损坏不再静默失去保护**：此前 `bootstrap` 解析失败即 `permConfig = {}`，`protected_paths` 与 `never_auto_approve` 变空（fail-open）；现回落到**内置受保护路径清单**并打印告警
- **审计归属**：规则变更记录 `agentId` / `sessionId`（确认弹窗触发的记在该会话上，CLI 记为用户操作）；同时修复 `AuditLog.queryRecent/queryBySession` 返回 SQL 行（`agent_id`）却被当作 `agentId` 使用的问题——审计面板的会话列此前恒为空
- **后台任务立即拒绝**：`job-runner` 此前只是"不注册"确认通道，实际会回落到 stdin 交互提示（受保护读白等 30 秒，且可能在提示里选到持久化授权）；现显式安装"立即拒绝"provider（确认与提问），任务结束恢复
- **写入副作用**：写回保留原文件 BOM、**行尾风格**、尾换行习惯与权限位；写临时文件后 `fsync` 再 `rename`；顺手清理超过 1 小时的遗留 `permissions.json.tmp-*`
- **保留设备名 / ADS**：`fs_write("NUL" / "CON" / "a.txt:stream")` 此前回报"已写入文件"（内容被丢弃）；现直接拒绝
- **端点细节**：非法 `scope`（`"proj"`、`"Project"`）一律 400，不再静默降级为 session 或退化成"不限来源"；`GET /permissions?x=1` 不再 404
- **规则顺序固定**：会话级在前、项目级在后（新增与文件重载同一顺序），`/permissions` 列表序号与规则表一致；CLI 新增 `revoke <序号> --project|--session` 来源限定（不符即拒，不撤错）
- **Web 面板**：展示 `warning`（如"配置文件未更新，重启后会重新生效"）、稳定 `{#each}` key、撤销/清空按钮 in-flight 禁用
- **测试**：新增/扩充反例——跨站与 token 校验、`?x=1` 路由、非法 scope、配置路径优先级与"跟随 `--dir` 首建模板"、mtime 重载、审计归属、写回风格（BOM/CRLF/权限位）、保留设备名、`--dir` 沙箱配置解析、后台任务立即拒绝、CLI 来源限定撤销；**端到端冒烟**（真实 `dist` + 真实 HTTP）复核 403/401/200、token 注入、懒重载与"仓库配置未被改动"

### 代码审查修复（第三轮：测试在受限机器上的硬失败）

> 由用户在本机跑 `npm test` 复现，非本机进程环境差异：该机器能建 junction（无需特权）但**建不了文件符号链接**（Windows 无开发者模式/管理员时 `symlinkSync(..., "file")` 报 EPERM）。

- **链接用例的硬失败（中）**：`test/path-policy.test.ts` 与 `test/tools.test.ts` 里用 `"file"` 创建悬空链接的两处用例，在无特权机器上直接抛 `EPERM` 而**不是 skip**——同一份代码在我这儿绿、在用户机器上红，属测试缺陷而非产品缺陷。现改为：悬空链接统一走 `makeDanglingLink`（Windows 用 junction，不需要开发者模式），链接能力抽成 `test/helpers.ts` 的 `makeDirLink` / `makeFileLink` / `makeDanglingLink` 与 `DIR_LINK_SUPPORTED` / `FILE_LINK_SUPPORTED` / `DANGLING_LINK_SUPPORTED` 探测，相关用例一律 `it.skipIf` / `describe.skipIf`
- **同类隐患一并收口**：`test/sandbox.test.ts` 与 `test/approval-service.test.ts` 里三处 junction 用例此前是"建不出就 `expect.fail`"，同样会在无链接权限的机器上变红；现改为能力探测 + skip
- **失败语义不让步**："解析失败一律拒绝"拆成两个用例——**组件数超限**（600 层不存在组件，无需任何链接权限）与**悬空链接 + 链接环**（`a → b → a`），后者在无链接能力时跳过；这样受限机器仍覆盖 fail-closed 判定，而不是整条用例消失
- **可复现**：`AIW_NO_LINKS=1`（无任何链接能力）与 `AIW_NO_FILE_LINKS=1`（仅文件符号链接失败，即无开发者模式的 Windows，本次用户机器即此情形）强制对应创建失败。实测：前者全量 978 通过 / 11 跳过，后者全量 **989 通过 / 0 跳过**（受限机器上覆盖不缩水），两者 `exit 0`

### 设备面板改为动态探测与模型视觉能力实测（用户反馈）

- **问题**：`default` 换成支持视觉的 `deepseek-v41-flash` 后，设备面板仍显示"不支持视觉"——面板只认 `config/models.json` 的 `vision: true`，而**同一个开关**还决定 `/chat` 能否接收图片（后果是带图请求被 400 拒绝）。配置声明与实际能力脱节时，界面既不报错也不提示怎么查
- **模型能力三级判定**：实测缓存（按**模型名**失效）→ 配置声明 → 未声明（明确报"未检测"并给出操作指引），不再把"没声明"当成"不支持"静默处理；判定结果与 `/api/v1/chat` 的图片门禁**同源**
- **实测探针**：`ModelRouter.probeVision()` 真实发一次 1×1 PNG（data URI）请求，`thinking:false` + 12 token 上限；只有端点**明确**报图片/多模态不支持才返回 `supported=false`，鉴权失败、网络错误、超时一律返回 `null`（"无法判定"），不猜；适配器不理会 `AbortSignal` 时由硬超时兜底（实测 120ms 强制超时 → "无法判定"）
- **新增写面**：`POST /api/v1/devices/probe`（`{kind:"model-vision"}`）按既有写面收口——跨站 403 → `X-AiWorker-Token` 401 → 参数 400，**未过门不调用模型**（测试断言 `calls === 0`）；结果写入 `<dataDir>/device-probe.json`，写失败降级为 warning 不影响结论
- **其余卡片同样实测**：运行时（Node/平台/架构/CPU/内存/PID/运行时长/数据目录可写性——真实写文件探测而非 `accessSync`）、存储（真实建库验证 SQLite 版本与 FTS5，失败原因原样展示）、ASR/TTS（缺失文件逐个列出）
- **面板**：模型能力卡增加来源徽标（实测 / 配置声明 / 未检测）、端点、采样参数与实测时间；新增【检测图片能力】（提示"一次极小图片请求"）与【重新检测】（不调用模型）；换模型后旧实测结果标注"此结果失效"
- **配置**：`config/models.json` 的 default 补 `"vision": true`（按用户确认该模型支持视觉）；即使不写这一行，实测通过后图片输入同样生效
- **测试**：新增 `test/devices.test.ts`（18 例：缓存读写与损坏容错、三级判定、过期失效、运行时/存储实测、探针成功/拒绝/鉴权/超时，并断言请求体确为 1×1 PNG 且关思考、低上限）+ `test/server.test.ts`（探测端点三道门、落盘后被 `GET /devices` 采纳、`/chat` 图片门禁按实测放行）
- **实测顺手抓到一处配置错误**：探针首次运行即发现 `config/models.json` 的 `model` 是 `deepseek-v41-flash`，官方端点返回 `400 The supported API model names are deepseek-flash, deepseek-v4-pro`——**该名字下所有对话请求都会失败，不只是图片**。用临时配置对候选名各实测一次：`deepseek-v4-flash`（原值）/ `deepseek-flash` / `deepseek-v4-pro` 均"接受图片输入"；按用户选择把 default 改为 `deepseek-flash`，并同步改掉 `contextWindow` 表里指向旧模型名的键
- **采样参数未配置时不再显示成 0**：`temperature` / `maxTokens` 未在 profile 中配置时保持 `undefined`（面板显示"默认"），此前被兜底成 `0` 会误导

### 产物工作台：右栏「文件变更 / 文档预览 / 回滚」三合一（Sprint 50）

- **问题**：同一批产出被拆在三个 Tab 里各拉各的数据源（`/diffs`、`/docs`、`/checkpoints`），用户要在三处找同一个文件；更关键的是**工具产物事件里的 artifacts 从未被任何端点读出**（`projectTrace` 投影 `tool/result` 时把它丢了），导致**图片/音视频/检索链接只在对话流卡片里闪一次，事后无处可查**
- **数据模型**：`src/types.ts` 新增产物工作台类型（`ArtifactItem` / `ArtifactWorkspace` / `DiffFile` / `DocEntry` 等下沉到领域类型），统一产物项带 `sources[]`（工具产物 / 文件系统快照 / 文档索引 / 回合检查点）与 `change/added/removed/restorable/turn/tool`
- **聚合**（`src/core/artifacts.ts`，纯函数）：`GET /api/v1/artifacts?sessionId=&scope=session|all` 合并四源。去重键 `project:<工作目录相对路径>`——**快照存的是绝对路径而工具产物给的是 `root+rel`，必须先用会话工作目录归一化**（实测同一文件能正确合成 `sources=tool+snapshot+checkpoint` 一条）；字段按权威源取值（kind/mime/size 取工具、added/removed/change 取快照、restorable/turn/tool 取检查点）；已删除文件仍列出并标注；老会话/无回滚服务/跨会话截断都写进 `degraded`
- **P0.1 修复**：`projectTrace` 的 `tool/result` 分支带上 `artifacts`（轨迹面板此前同样取不到产物）
- **文档索引复用**：`/docs` 的扫描逻辑抽成 `src/core/docs-index.ts`（只收 `.md`、深度/数量/大小上限原样保留），`/docs` 与新端点共用一份实现
- **后端其它**：`replayEvents` 的消息带上 `seq`（Web 据此把用户消息映射到回合，做「从这里重新开始」）；`GET /artifacts` 缺 `sessionId` 或非法 `scope` → 400，未知会话 → 空结果而非 500
- **前端右栏 5 → 3 Tab**：新增「产物」（`ArtifactsPanel` + `ArtifactList` + `ArtifactDetail` + `DiffView` + `TimelineStrip`），删除 `FileDiffPanel` / `DocPreviewPanel` / `RewindPanel`；「应用预览」按用户裁定改名「**应用**」；「权限」Tab 暂留（其迁移属下一次 IA 改造）
- **交互**：回滚从"独立面板"降级为**产物面板底部的时间线**——点选回合只**高亮**该回合产物（不隐藏其他，避免"东西不见了"）；范围默认「仅代码」（危险面最小）并保留「代码 + 对话」，两者均先 `dry-run` 预览（按所选范围预览，数字与实际一致）再二次确认；`terminal_exec` 不可回滚项仍列「跳过」
- **「仅对话回滚」下移到对话流**：用户消息 hover 显示「从这里重新开始」，按 `messageSeqBefore` 把消息映射到回合，同样先预览后确认；无序号（本地新发未刷新）或超 20 轮窗口时**明确提示**而不是猜一个回合
- **查看器复用**：`.md` → `DocRenderer`、文本/代码 → `/files` 原文、图片内联、diff 行级高亮、链接卡；视频/音频/PDF/Office 复用既有 `FilePreview` 窗口（含 mammoth/SheetJS 转换），不重造第二套渲染
- **测试**：新增 `test/artifacts.test.ts`（15 例：判型与路径归一化、三源去重与权威源、link 去重、deleted 保留、二进制降级、新增/修改判定、范围差异、跨会话截断、时间线排序、`collectDocs` 语义、端点 400/未知会话）；`test/session-events.test.ts` 补 `seq` 断言（回放消息带 seq 且单调）
- **用户实测发现的缺陷（已修）**：产物面板里点击 **项目文档**时永远停在"加载文档…"。两个原因叠加：① 新面板给 `DocRenderer` 传的是 `rel`，漏了 `project:` 前缀——`DocRenderer` 会把无前缀路径当**会话文档**去 `data/docs/` 找，请求 `root=session` 实测 404（正确请求 `root=project` 实测 200 / 88 行正文）；② `DocRenderer` 对非 2xx **直接 `return`**，界面因此永久停在加载态而不是报错。修法：`toDocKey(root, rel)` 收成 `$lib/artifacts.ts` 的唯一实现（`FilePreview` 原本自己拼字符串、写法正确但属于同一处逻辑两份实现，一并改为调用它）；`DocRenderer` 增加 `error`/`loaded` 状态，404 显示"文档不存在或不在 <root> 根内"、空文档显示"（文档为空）"，不再把失败伪装成加载中
- **用户实测发现的缺陷（二）：产物面板「在对话中查看」点击无反应**。同样是两层**静默**失效叠加：① 消息锚点 `id="msg-N"` 只加在**用户**消息上，而工具卡片（产物所在）在**助手**消息上 → `getElementById` 返回 `null`，`el?.scrollIntoView()` 什么都不做；② **刷新后时间线里根本没有 artifacts**——`replayEvents` 构造 tool 消息时没带 `artifacts`、`loadRemoteMessages` 也没往时间线项上拷（只有实时流那条路径会写）→ 匹配失败后提示只写在**面板顶部**，用户在详情区看不到。修法：`replayEvents` 的 tool 消息带上 `artifacts`（实测会话 `cmtvk4fo`：7 条 tool 消息中 4 条带产物，样例正是被点的那篇 `reports/…md`）+ `loadRemoteMessages` 写入时间线 + 锚点覆盖**所有**消息 + 结果提示就地显示在详情区（找不到卡片时说清原因：本轮之前写入 / 已回滚 / 来自其他会话），不再有"静默失败"
- **产物面板左列表 / 右详情支持拖拽调宽**（用户反馈：此前是写死的 `minmax(150px, 40%)`）：与 `App.svelte` 右栏 resizer 同一套 pointer 交互（`pointerdown` + window 监听 move/up，clamp 到 `140px ~ 容器宽-220px`），宽度持久化到 `localStorage`（`aiworker_artifacts_list_width`）；**双击或聚焦后按 `Home` 复位默认 40%**、`←/→` 每次微调 24px；分隔条改为**始终可见**的细线（hover/聚焦高亮）——用户找不到它说明发现性不足，不能只在 hover 时才出现。默认分裂比仍固定 40/60（不用 `flex: 1 1 auto`，避免长路径把详情挤窄）
- **产物面板铺满可用高度**（用户反馈：预览下方大片留白 → 追加反馈：左列表同样如此）：此前我用**按视口高度裁剪**的写法限制内容区（`.aw-list max-height:46vh`、`.aw-detail max-height:52vh`、详情内 `.ad-pre/.ad-doc/.dv-lines` 同样是 `52vh`），结果是内容到 52vh 就截止、下面是死区，长文档还会在中间被裁断。现改为 **flex 铺满链条**：右栏是 flex 列 → `.aw { flex:1 1 auto; min-height:0 }` → `.aw-body` 同 → `.aw-list`/`.ad-viewer` 各自滚动、`.ad-doc { height:100% }` 给 `DocRenderer` 确定高度（它自身就是 `height:100%` + 内部滚动，缺的只是确定高度）；时间线用 `flex:0 0 auto` 不被压缩。**左列表另有一处叠 bug**：`.aw-list` 与 `ArtifactList` 的 `.al` **两层都 `overflow-y: auto`**，且 `.al` 没有 `flex:1 1 auto` → 列表会长到窗口底部、最后几行被时间线压住且够不着。现改为**单层滚动**（只 `.aw-list` 滚动）+ `.aw-list { display:flex; flex-direction:column }` + `.al { flex:1 1 auto; min-height:0 }`。构建后 CSS 已核对：`.aw-body/.aw-detail/.ad-viewer/.ad-doc/.aw-list/.al` 规则就位，产物面板内 `max-height:52vh` 归零、`.al` 不再有 `overflow`
- **修复 Markdown 大纲定位失效**（用户反馈：点大纲条目不跳转）：`jumpTo` 原来**假设 `.dr-render` 就是滚动容器**，用 `renderEl.scrollTop + (e.top - r.top)` 手算偏移；Sprint 50 把外层改成 `.ad-viewer { overflow:auto }` + `.ad-doc { overflow:hidden }` 后，滚动可能落在别的祖先层，这个算术落空且**失败时没有任何反馈**（又是静默失败）。现改为沿祖先链找**第一个真正可滚动**的容器（`overflow-y ∈ auto|scroll|overlay` 且 `scrollHeight > clientHeight`）再滚，找不到才退回 `scrollIntoView`（配 `scroll-margin-top: 8px`）；锚点查找改为**先在本实例 DOM 内** `renderEl.querySelector('[id=...]')` 再回落 `document.getElementById`——同页出现第二个 DocRenderer 实例时不会再取错元素。找不到锚点时在**大纲列就地提示**，不再静默。顺带把大纲列从 `width:150px; flex-shrink:0` 改为 `flex: 0 1 150px; min-width: 92px`，窄面板下不再被挤出可视区
- **修正「在对话中查看」的定位语义**（用户要求核对）：原实现用 `findIndex` **从对话开头**找含该路径的工具卡片，而产物项展示的 `turn` 是**最新**回合（快照/检查点后写覆盖，`listTurns` 升序确认）——文件被多次读写时会跳到**最早**那张卡片。实测会话 `cmtxr65k` 的 `web/sea-song.html` 被工具产物命中 **26 次**（条目 #2 … #17）：旧逻辑跳 #2（对话最上方），新逻辑跳 #17（最近一次）。同时把定位粒度从"整条助手消息"细化到**那张工具卡片**（`ToolCard` 增加 `data-call-id`，用 data 属性匹配避免 callId 特殊字符；一条消息含多张卡片时不再只闪整条）。`TimelineItem.id` 可能缺失 → 类型检查报错后改为回落到整条消息
- **定位高亮从「闪一下」改为「持久标记 + 脉冲 + 多命中走查」**（用户反馈：1.6s 高亮太短、容易丢焦点）。设计取舍：**脉冲只负责吸引注意，持久环负责不丢焦点**——命中后加 `.artifact-focus`（主题色描边 + 淡底）**一直保留**，直到切换产物、按 `Esc` 或点「清除高亮」；开场另有 `.artifact-pulse`（2.4s）指向性脉冲，连续定位同一元素时用"移除→强制回流→再加"重启动画（否则第二次不触发），并尊重 `prefers-reduced-motion`（关动效时只剩静态环）。此外一个产物往往命中多处（实测 `web/sea-song.html` 命中 26 次），详情区现在显示「已定位：第 n/总数 处（1 = 最近一次）」并给出 **↑更早 / ↓更近 / 清除高亮**，可逐处走查；Esc 亦可清除。样式放在全局 `app.css`（原先的 `.msg-flash` 一次性动画已删除，避免两套机制并存）
- **修正「在对话中查看」的定位粒度**（用户反馈：高亮框住了**整个中间对话区**，比之前的消息级还差）：根因不是高亮样式，而是**目标卡片根本不在 DOM 里**——`ToolsGroup` 把连续多个工具调用折叠成「工具调用 (N)」，且 `{#if open}` 折叠时**子卡片完全不渲染**，于是 `data-call-id` 查不到、回退到**整条消息容器**（长会话里那条消息极高，视觉上就是整个对话区被框住）。修法两条：① 新增 `focusToolCallId` store，定位前先置入该 callId，`ToolsGroup` 据此**自动展开**所在分组，`await tick()` 等渲染完成后再取卡片；② **取不到具体卡片时只滚动、绝不加环**，并就地说明"已滚动到该消息，但未找到具体工具卡片"——不再用大范围描边冒充定位。`clearFocus` 同时清空该 store
- **修正定位高亮在「折叠分组内的卡片」上完全不可见**（用户反馈：最下面那张命中的卡片没有高亮）：两个原因叠加，且都只在这种卡片上暴露——① `ToolsGroup` 是 `.tools-group { overflow: hidden }`，而 `outline` 画在元素**外侧**，被祖先裁掉；② 组件样式 `.tool-card { background: var(--surface) }` 与全局 `.artifact-focus { background: … }` **同权重且更靠后**，把底色盖掉。结果：分组内卡片点上去视觉上毫无变化。修法：`outline-offset: -2px`（内侧描边，不受祖先裁剪）+ 底色改用 `box-shadow: inset 0 0 0 9999px`（inset 阴影绘制在内容之下，且不参与 `background` 的级联竞争）；脉冲同步改为 **inset 扩散**（原先向外扩散的 box-shadow 同样被裁）
- **修正产物查看器的档位：图片/媒体「内容优先」，改动改为可切换**（用户反馈：SVG 是图片资源，产物面板却不预览）。先核实结论：SVG **本来就是**图片产物（工具侧 `svg → image/svg+xml → kind=image`，实测会话 `cmtvk4fob` 的三个 svg 产物事件即 `mime:"image/svg+xml",kind:"image"`，`/files` 也以 `image/svg+xml` 直出），错的是**查看器优先级一刀切**：`ArtifactDetail` 原先 `diff > 内容`，而 `diffMap` 是 `/diffs` **全量按路径**建索引（跨会话也命中），于是刚生成/改过的图（快照里 100+ 行全 `+` 的 SVG 源码）点开看到的是**满屏 `+ <svg …>`**，视觉上等同"不支持预览"；对话流里反而正常（`ToolCard → FilePreview → <img>`），两边表现不一致。修法：把「内容」与「改动」拆成**正交两档 + 段控切换**，默认档按 kind 定——**文本/代码（含 md）保持改动优先**（既有裁定不变），**图片/媒体内容优先**；图片档补 `onerror` 兜底（此前碎图无任何解释，`FilePreview` 早有"加载失败，请下载"，同一功能两套标准）与「文件已删除」的显式说明（不再发一次注定 404 的请求）。切换产物时档位复位，避免上一项的选档串到下一项。**追加修复（用户截图：切换按钮下边缘被切）**：两根因叠加——① `.ad` 是 flex 列，除查看器外各行默认 `flex-shrink:1`，而查看器的 `flex-basis:auto` 等于其内容高度（几百到几千 px），收缩量按「基准×因子」分摊，**小行也会被分到十几 px 的收缩**；行内文本溢出还看得见，但 `.ad-toggle` 当时有 `overflow:hidden`（为段控圆角），于是**只有它把收缩暴露成可见裁切**；② 按钮高度依赖行盒撑开 + 容器裁圆角，本身就有取整/裁切风险。修法：`.ad > *:not(.ad-viewer){flex:0 0 auto}`（`.aw > *:not(.aw-body)` 同理，工具条/时间线一并免疫）、**容器彻底去掉 `overflow:hidden`**（改为给首/末按钮各自圆角）、按钮改 `inline-flex + align-items:center + line-height:16px` 让高度由字高确定。构建后 CSS 已核对：`.ad-toggle` 无 `overflow`、`flex:0 0 auto` 就位
- **HTML 产物新增 sandbox 渲染预览**（用户反馈：HTML/JS 这种文件切「内容」是否有必要、HTML 不支持预览吗）。先划清两件事：**「全文」不是多余的档**——改动档只含变更行、没有上下文（`src/hooks/handlers.ts` 的 LCS 只推 `+/-`），对**改过的文件**"看完整文件"与"看改了什么"是两个真实需求；但对**新增文件**（如 `+674 −0`）改动档本身就是全文，两档看着一样，所以旧标签「内容」既不准确也容易误解。现按 kind 把标签说清：`text → 全文`、`markdown/html → 预览`、`image → 图片`、媒体/PDF/Office → `说明`。同时补上真正缺的那一档：`.html/.htm` 走 **`HtmlPreview`（`<iframe sandbox="allow-scripts">`，绝不给 `allow-same-origin`）**，产物面板与文件预览窗**共用同一个 sandbox 实现**（新增 `web/src/components/HtmlPreview.svelte`），默认档 = 预览，源码与改动为可切换档
- **安全面：`/files` 直接导航时对 HTML/SVG 追加 `CSP: sandbox` + 恒发 `nosniff`**。理由不是洁癖：`/api/v1/files` 与 Web **同源**，而 `index.html` 内联了 `window.__AIWORKER_TOKEN__`（该响应故意不带 ACAO）；Agent 写的 HTML 若以同源文档执行，`fetch("/")` 就能读到 token 再调权限写接口——**等于把"一个产物"变成"提权入口"**（同理，绝不能给 HTML 产物加"新标签打开"）。`fileSecurityHeaders()` 仅在**导航请求**（`Sec-Fetch-Dest: document|iframe`）上对 `text/html` 加 `sandbox allow-scripts`、对 `image/svg+xml` 加 `sandbox`，所以 `<img>` 与文档内图片不受影响；新增用例覆盖"导航加头 / 子资源不加头 / 非 HTML 不加头"三种情形。**如实标注边界**：opaque origin 下 `type="module"` 脚本与相对 `import` 会被拦，引用同目录兄弟资源的相对路径也不会解析（`/files?path=…` 的基址不是文件目录）——自包含单文件 HTML 不受影响，多文件站点需另加路径式预览路由（已记入设计文档待办）
- **顺手修掉门禁里一个既有 flaky（P0-7）**：`test/memory.test.ts` 的 turn_logs 用例用两次独立的 `Date.now()` 生成 `startedAt/finishedAt` 再断言差值恰为 1000，跨毫秒即 1001/999（全量并行跑时偶发红，单跑必绿）。改为同一时间基准；`memory.test.ts` 连跑 5 次、全量 `npm run verify` 连跑 2 次均全绿
- **诚实边界**：`/diffs` 是工作目录快照，可能含非本会话改动 → UI 打「文件系统快照」来源标并说明；「在对话中查看」因 WS `tool_result` 无 `callId`（既有局限）按路径匹配，精确化留待后续；跨会话工具产物只聚合有文件改动的最近 10 个会话并标注截断

## 1.6.0 (2026-09-12)

### P0 收口：headless 一键运行（`-p`）与检查点回滚（Sprint 48）
- **运行时装配层**：抽出 `src/core/bootstrap.ts`（`createRuntime`）与 `src/server-deps.ts`，`src/index.ts` 收敛为交互 / server / headless 三套薄壳；TUI、banner、状态区、定时调度器只在交互（或服务）形态下启用。装配顺序与依赖注入与抽出前逐字一致，纯搬迁零行为变更（新增 `test/bootstrap.test.ts` 守护，含"hooks→检查点"接线用例）
- **headless 模式**（`aiworker -p "<prompt>"`）：`--output-format text|json|stream-json`（NDJSON：`system`/`thinking`/`text`/`tool_call`/`tool_result`/`confirm_denied`/`result`/`error`）、`--session` 续接、`--agent` 指定专家、`--max-iterations` 覆盖、`--yes` 显式放行；stdout 只放结构化输出，日志与告警走 stderr；**没有确认通道时 fail-closed**（`confirm_denied`，不沿用 stdin 的 30 秒超时），`ask_user` 直接失败而非挂起；退出码 `0` 成功 / `1` 运行失败 / `2` 参数错误（装配前校验）/ `3` 权限拒绝 / `4` 达迭代上限 / `130` 中断；进程结束前释放应用子进程与 MCP 连接（否则事件循环不退出）
- **`AgentRunResult.error`**：agent-loop 原本把循环内异常折成 `text`（"Agent 循环异常: …"）返回，headless 会把它当成成功结果（连接失败退出码 0）——现显式带出错误，`result` 载荷含 `error` 且退出码为 1
- **检查点**（`src/core/checkpoint-store.ts`）：每回合在 `<data>/checkpoints/<sessionId>/turn-<n>/` 落盘 manifest 与**变更前内容** blob；捕获点复用既有 `captureDiff` hook（`fs_write`/`fs_edit` 精确），`terminal_exec` 等由指纹扫描发现的变更只记 `restorable: false`；记录 `hashAfter` 用于冲突检测，`messageSeqBefore`/`eventSeqBefore` 用于对话回滚定位；单文件 > 2MB 或二进制不入 blob，每会话保留最近 20 轮（`AIWORKER_CHECKPOINT_KEEP` 可覆盖），manifest 损坏 fail-soft；新增 `src/hooks/turn-registry.ts` 让轮次日志与检查点共用同一序号
- **`/rewind`**：`/rewind` 列检查点，`/rewind <n>` 先预览再交互三选（代码+对话 / 仅对话 / 仅代码；无提问通道则取消），`/rewind <n> --code|--chat|--all [--dry-run] [--force]`；对话回滚**不删事件**，而是追加 `rewind/applied` 标记，`replayEvents` 据此截断派生视图（`verifyProjection` 同步，轨迹与审计仍可回看）；冲突（外部改动 / `terminal_exec` 影响）默认跳过，`--force` 才覆盖；`RewindService` 的预览与执行共用同一判定
- **HTTP 与 Web**：新增 `GET /api/v1/sessions/:id/checkpoints` 与 `POST /api/v1/sessions/:id/rewind`（`dryRun` 返回预览，成功后广播 `session/update kind=rewind`）；Web 右侧栏新增「回滚」Tab（`RewindPanel.svelte`）：回合列表 + 文件动作预览 + 冲突勾选 + 二次确认（复用 `ConfirmModal`），回滚后清本地缓存并重拉消息投影；WS 收到其他端的回滚广播时同步刷新当前会话
- **测试与门禁**：新增 `test/headless.test.ts`(17)、`test/checkpoint.test.ts`(10)、`test/rewind.test.ts`(13)、`test/bootstrap.test.ts`(6)；全量 **909 / 63 文件** 全绿，`npm run verify` 一条命令通过，`svelte-check` 0 错误（65 warnings 与基线持平）
- **诚实边界**（README 与代码注释同步）：`terminal_exec` 造成的改动不可回滚（明确列入"跳过"）；检查点只覆盖 AiWorker 自己改过的文件；回滚是文件级整体还原而非按行撤销；headless 是单轮执行，不做后台长跑

## 1.5.0 (2026-09-11)

### 修复：文档预览不显示 Markdown 中的图片
- **原因**：`marked` 渲染出的 `<img src="assets/x.svg">` 是相对路径，浏览器按 Web 页面 URL（而非文档所在目录）解析 → 404；文档面板与工具产物预览共用 `DocRenderer`，两条路径都受影响
- **修复**：新增纯函数模块 `web/src/lib/asset-url.ts`，渲染后把**明确的本地引用**改写为 `/api/v1/files`——相对路径按文档所在目录归一化（`./`、`../`、反斜杠、中文/空格编码、丢弃 query 但**保留 `#fragment`**）；本地绝对路径（Windows 盘符 / UNC / `file://`）交给服务端做根白名单校验；越界 `..` **不静默夹回根内**，交由服务端 fail-closed 拒绝
- **兼容性（既支持本地文件也支持外部链接）**：外部链接（`http(s):`、协议相对 `//cdn`）、内联（`data:`、`blob:`）、锚点、**站点根相对（`/logo.png`，如 `web/public` 下的静态资源）** 与已改写引用一律**原样保留**；改写后的本地引用若加载失败（404 / 被根白名单拒绝），前端会自动回退为原引用，保证不因改写而丢图
- **服务端**：`GET /api/v1/files` 新增 `root=session|project` 参数（session=`data/docs`、project=会话工作目录），与 `/docs/content` 的根语义对称，用于解析文档内图片
- **渲染**：`DocRenderer` 图片样式自适应（`max-width:100%`，独占段落居中）
- **测试**：`test/doc-assets.test.ts` 11 例（相对/盘符/UNC/`file://`/外部链接/站点资源/内联/片段/越界/中文编码 + `rewriteDocAssetUrls` 混合文档契约）+ server `/files` 的 `root` 语义与越界用例；另用仓库真实文档与其 `assets/*.svg` 做了端到端验证（本地图片 200/`image/svg+xml`，外链与站点资源逐字未改写）

### 可信基线：CI 门禁 + 权限规则化 + Windows 最小沙箱（Sprint 47）
- **CI 门禁**（`.github/workflows/ci.yml`）：push/PR 双 job——后端（`npm ci` → build → lint → test）与 Web（`npm ci` → svelte-check → build）；新增 `npm run verify`（一条命令跑全部门禁）与 `npm run check:web`
- **Web 静态检查**：引入 `svelte-check` 依赖与 `web/svelte.config.js`，修复既有 62 个错误（其中 31 个为"读不到 Svelte 配置"的系统性问题、约 28 个为类型滞后于功能的真实错误：Tab 联合类型缺项、`possibly null`、接口缺字段等），门禁阈值 `--threshold error`；不引入 `any`/`ts-ignore`
- **权限规则化**（`config/permissions.json`）：模式之上叠加 `Tool(specifier)` 级规则——`rules`（`tool` glob + `match` 目标 glob + `action`）按 **deny > ask > allow** 求值；`never_auto_approve`（永不自动批准）与 `protected_paths`（受保护路径，写入类工具强制确认）；`allow` 仅 auto 模式免确认、不绕过只读模式、不可覆盖前两者；plan 模式保持全确认
- **目标串（specifier）语义**：fs 类 = 解析后的绝对路径；`terminal_exec`/`terminal_session` = 命令文本；其余 = 参数 JSON（`extractTarget()` 导出供测试复用）
- **Windows 最小沙箱**（`config/sandbox.json` 新增 `allowWriteDirs`）：`terminal_exec` 与 `terminal_session` 统一走沙箱——重定向（`>`/`>>`）与写入类命令/程序片段内**所有**像路径的参数（源与目标）必须落在可写根内；含变量/通配无法静态解析的目标 fail-closed 拒绝；伪目标（`2>&1`/`>nul`/`/dev/null`）与注释文本不误判。**如实标注为策略级启发式防线，非 OS 级隔离**
- **测试确定性**：修复两处 captureDiff 用例依赖共享快照目录 + mtime 排序的潜在竞态（改为每次运行独立 sessionId，断言快照唯一）；新增 `permissions-rules` 14 例、沙箱写入约束 12 例；全量 **863 / 59 文件** 全绿
- **文档**：新增 `plans/roadmap-next.md`（P0/P1/P2 路线图）、`plans/sprint-47-credibility-baseline.md`（设计与验收）；README 补充权限规则 schema、沙箱边界与 `verify` 命令

### 代码审查跟进：沙箱写入约束与受保护路径加固
- **沙箱**：原"取命令位置后第一个非开关 token"被三类常见写法绕过——带值开关顶位（`Set-Content -Encoding utf8 <越界>`、`New-Item -ItemType Directory -Path <越界>`、`Add-Content -Value hi -Path <越界>`）、目标不在首位（`Copy-Item a.txt <越界>`）、别名与未列举程序（`rm -rf`、`ni`/`sc`/`cp`/`mv`/`ri`、`curl -o`、`Invoke-WebRequest -OutFile`、`robocopy`、`xcopy`、`tar -C`、`Expand-Archive`、`git clone`、`npm install --prefix`）。现改为校验片段内**所有**像路径参数并纳入上述别名/程序；引号内文本用等长掩码定位、回取原文取参数
- **重定向引号感知**：非包裹命令中引号内的 `>` 不再视为重定向（`echo "compare > C:\x"` 不再误拒）；解释器包裹（`cmd /c "echo x > …"`）仍按引号不敏感扫描，越界照样拦截
- **受保护路径按路径段匹配**：`.git` 不再误伤 `.gitignore` / `.gitattributes` / `.github/**`（原实现在 auto 模式下会强制确认、无确认通道时直接拒绝）；命令文本先拆候选片段再切段，`git config --file .git/config` 仍命中；默认补 `.envrc`
- **规则加载校验**：`tool` 非空串、`action ∈ deny|ask|allow`、`match` 为字符串或缺省，否则丢弃并告警——避免 `"action": "denyy"` 使 deny 规则**静默失效**
- **`allow` 免确认显式限定 auto 模式**，不再依赖 `permissionCheck` 先于 `confirmHighRisk` 的隐式钩子顺序
- **行为变更**：写入根约束现**先于**危险检测生效，`rm -rf /` 由"确认后可执行"变为"任何模式直接拒绝（写入越界）"；需终端写入项目根之外时请在 `allowWriteDirs` 中声明
- **顺带修复**：`FileDiffPanel.sessionTitle` 读 `DiffSession` 上不存在的 `id`（无 summary 时会 `undefined.slice` 抛错）→ 改 `sessionId`；`asset-url` 的 `/files` 前缀补边界判断；`DocPreviewPanel` 行类型 `collapsed` 改为仅目录行必填；`check:web` 统一走 `web` 的 `check` 脚本

### CI 首次运行修复（Linux runner）
- **根因**：`data/` 被 `.gitignore` 忽略，全新检出没有该目录，而 `AuditLog` / `SessionStore` 直接 `new Database(路径)`（better-sqlite3 **不会自动创建父目录**）→ 审计写入抛 `Cannot open database because the directory does not exist`。`app-runtime` 的 `onExit` 恰好在**安排重启之前**写审计，异常导致退避重启整段不执行 → 崩溃重启用例失败
- **修复**：两个构造函数在打开前 `mkdirSync(dirname(路径), { recursive: true })`（同时对"首次运行没有 data 目录"是产品级健壮性修复）
- **顺带修复崩溃语义**（原实现与"指数退避重启 ≤3 次"不符）：① 崩溃计数原本存在 `proc` 上、每次重启都是新对象 → 计数重置，退避永远停在 1s 且永不触发 `onCrashed`；现改为运行时级 `crashCounts`（跨重启保留，用户显式 `start`/`stop` 时重置）。② `waitReady` 超时与心跳无响应走 `kill()` 会把 `stopped` 置真 → `onExit` 直接 return，既不重启也不回调；现区分"用户停止"与"按崩溃处理"（`killAsCrash`）。③ 退避间隔可通过 `crashDelaysMs` 注入（测试用）
- **测试**：`scheduler` / `app-runtime` 用例把审计日志初始化到各自测试目录（不再依赖 cwd 下的 `data/`）；新增"启动始终未就绪 → 计崩溃、退避 ≤3 次后 onCrashed"用例；`extractTarget` 断言改为平台无关（Windows 盘符在 POSIX 下按 `resolve` 口径）；`app-runtime` 的 ready 超时与轮询上限放宽以适配 CI 负载

## 1.4.0 (2026-09-10)

### 工具产物预览：文件/链接/diff 全链路（Sprint 46）
- **产物模型**：`ToolResult.artifacts`（`ToolArtifact` = file/link/diff，含 mime/kind/size/root/rel）；新增 `src/core/preview.ts`（扩展名 MIME 表、kind 归类、文本判定、头字节二进制嗅探、极简行 diff、大小格式化），纯函数无副作用
- **工具产出**：`fs_read`（文本整读＋超阈值标 truncated；未知扩展名先读 512 字节嗅探，二进制改回短元信息，不再把二进制毁成乱码）、`fs_write`/`fs_edit`（文件产物；`fs_edit` 另附局部 `-/+` diff）、`web_search`/`web_fetch`（链接产物含站点/标题/摘要）
- **TUI**：工具块下渲染产物 chips（📄 文件 + 大小、🔗 链接、📝 变更），终端支持 OSC 8 时文件 `file://` / 链接可点击；URL 与标签先剥控制字符防终端注入
- **Web**：工具卡产物 chips + 预览窗口 `FilePreview`——Markdown 复用 `DocRenderer`，代码/文本走 `/files` 原文，图片/视频/音频/PDF 原生元素（支持 Range seek），Office 前端转换（docx→mammoth、xlsx/csv→SheetJS，DOMPurify 净化），pptx 等下载兜底，diff `+/-` 着色
- **文件端口** `GET /api/v1/files`：realpath ＋ 根白名单（会话项目目录 + data 下仅 `docs`/`spills`）反遍历、64MB 上限、单区间 Range（206/416）、`download=1` 附件下载（RFC 5987 `filename*` 支持中文名）、`file:preview` 审计（成功/拦截）
- **预览窗口交互**：右下角拖拽调大小（最小 300×180、视口夹紧、尺寸跨打开记忆）、全屏切换、`Esc` 先退全屏再关闭、切换产物滚动归零

### 模型状态栏即时刷新（修复"Web 设置模型不生效/状态栏不变"）
- `/status` 与各 `done` 事件统一返回 `getDisplayModel()`（profile 生效时含 `(key)` 后缀）
- 新增 `refreshStatus()` 单点实现（App 轮询与 SystemPanel 保存后共用）；SystemPanel 模型下拉改读事件目标值，保存后立即刷新状态栏，无需等 30s 轮询

### 协作工作会话隔离（修复"一次协作拆出多个会话"）
- 多智能体 `/plan`、`/debate` 的每步/每轮运行会话统一带 `wk-` 前缀：保留上下文隔离（`assembleContext` 按会话回放），但不出现在 `/sessions`、TUI 与 Web 侧栏
- Web `syncServerSessions` 增加幽灵会话清理（后端已删除的本地残留），并以 `?limit=1000` 全量比对避免仅取前 50 误删

### Code review 修复（第 5 轮）
- `/files` Range 解析健壮化：畸形头不再产生 `NaN` 送进 `createReadStream`（进程崩溃风险），多区间显式 416，206 分片不再重复记审计
- data 根收窄为 `docs`/`spills` 白名单：`aiworker.db`、运行时配置等不再可经 `/files` 下载
- 空文本文件预览不再永久停在"加载中…"；根外 Markdown 产物回退原文渲染（避免 DocRenderer 404）
- `listSessions` 过滤改 SQL 参数绑定；`appendEvent` JSDoc 格式回归还原；移除未使用的 `isWorkerSession`
- 测试：新增 `/files` Range 边界、CJK 下载名、data 根白名单隔离用例；全量 824 全绿

## 1.3.0 (2026-09-06)

### TUI 块式会话视图：思考/工具/回答可折叠（Sprint 45）
- **回合块化**（`turn-view.ts` + `MessageList` 条目化）：一次问答回合 = 结构化块（thinking/tool/ask/text/note/meta），块按到达序渲染；历史回合保留结构可回看折叠
- **思考流式摘要（修复"思考不流式"）**：思考默认折叠但标题实时滚动摘要与字数（`🧠 思考 · 摘要… · 已 N 字 ▸`）；`--show-thinking`/`/config thinking` 语义升级为"默认展开全文"，不再是一刀切隐藏
- **工具卡原位更新**：`🔧 工具 参数 ⌁耗时 ✓/✗` 由块状态驱动，running→done 不再追加新行；`o` 展开完整参数/结果
- **折叠键位**：运行期 `t`/`o`/`c`/`e`/`[`/`]`（当前回合）；空闲 `[` 进入浏览模式回看历史回合（`[`/`]` 焦点环跨回合、`t`/`o`/空格 折叠、`Esc`/字母退出）
- **ask_user 块化**：提问在回合内以块展示（高亮/勾选/超时结算压缩为一行），消除旧静态行错位；无回合路径保留兜底
- **渲染预算**：thinking 展开正文与 tool 详情按行预算截断（折叠内容完整保留），防巨型展开拖帧；text/回答全量输出
- **输出收口**：TUI 消息区写入统一经 `appendToViewport`，运行期外部 stdout 重定向进当前回合；fence/table 状态机回合级重置
- 非 TUI（stdout/管道）与 Web 行为不变
- 测试 +28（turn-view 11 / MessageList 条目化 7 / output 注入 4 / tui 回合交互 6）；全量 806 全绿

### 交互修正（实测反馈）
- **回答重复渲染修复**：`turn-view.textLine` 提交成品行时清除 `lastPartial`——流式半行随换行提交后不再残留在半行槽，修复回答内容逐句翻倍（含 `flush`/`textCommit` 二次提交、以及"某句先做半行后换行完成"两种重复路径）
- **长行 wrap 丢色修复**：`MessageList.wrapSingle` 提取行首样式组并在换行后的每个分段前重放——思考/工具等 dim/彩色长行不再"一行灰一行白"
- **长行 wrap 丢边界修复**：`wrapSingle` 同时提取行首"悬挂边界"字面量前缀（空格+`│`/左块）并在每个换行分段前重放——思考/工具长行折行后左竖线不再中断、续行文字不再顶到边界（顺带保留列表/引用/代码块的悬挂缩进）
- **工具详情 gutter 对齐**：tool 详情前缀由 `    │ ` 改为 `  │ `，与 thinking 正文、块标题首列（`🔧` 起始列）统一到列 2，消除工具区竖线与标题错位
- **区域显式分界**：回答正文块与外部输出（raw）前各插一条 dim 分隔线；思考正文统一 dim 灰 + `│` 缩进纹理、工具标题蓝色系，三者一眼可辨
- **空闲交互改为"焦点导航"**（取代浏览模式）：输入为空时 `←`/`→` 在历史回合可折叠块间移动焦点、`Enter` 折叠/展开、`Esc` 清除高亮；不再绑定 `t/o/c/e/[/]` 字母键，正常输入零误识别；`Space`/`Enter` 仅在输入为空且存在焦点时才折叠，无按键冲突
- 运行期仍保留 `t/o/c/e/[/]`（字符此时被系统忽略、无输入冲突）

## 1.2.0 (2026-09-06)

### Token 统计与上下文窗口展示＋费用移除（Sprint 44）
- **三档 token 口径**：本轮＝会话账本差分（ModelRouter.sessionScopes 按 scope=sessionId 记账，TurnLog 轮次结算，含同轮压缩请求、不含 loop 外摘要）；会话＝session_events 事件求和持久（assistant/message 携带单次请求 usage，`GET /sessions/:id` 返回 usages 平行数组）；全局＝进程级计数器（TUI `/status`、Web 状态栏标注"全局"）
- **上下文窗口可配置**：`config/models.json` 顶层 `contextWindow` 表按 provider / provider.model 声明；解析链 profile.contextWindow → 顶层表 → 内置表（deepseek 1M、openai 128k、anthropic 200k、google 256k）→ 32768 兜底；profile 级覆盖与键大小写兜底；`ModelRouter.getContextWindow()` 供 TUI/Web 展示与占比计算
- **占比展示**：TUI `/context`（分层占用＋窗口＋剩余可用）、`/status`、回合 footer「本轮 ↑x ↓y tok（窗口 p%）」保留 1 位小数；Web 上下文 Tab（每会话按 agent 窗口）、气泡脚注「本轮/请求」区分实时与历史口径、设备徽标窗口、StatusBar 全局 tok
- **压缩预算与物理窗口分离**：COMPRESS_BUDGET=32768 作成本护栏；物理窗口小于预算时（本地 16384 模型）按窗口收紧触发阈值与保留目标，防输入溢出（review 补充）
- **计费统计移除**：`getCost()`/PRICING/pricing 全仓删除，费用由模型平台账单核对
- **Web 修复**：Svelte 5 snippet `{@render}` 用法（修复 "Ye is not a function"）、智能体工具勾选保存不生效/回显丢失（内置 agent 构造时热载 YAML）、恢复默认 400（无 body 不解 JSON）、permissions 嵌套读写
- **Code review（第 4 轮）**：/chat 同会话并发 409 护栏＋done TurnLog 归属校验＋回传真实 sessionId、GET /sessions/:id 单次读事件与 404 语义、usage NaN 护栏与死代码清理、Web 会话切换/上下文/轨迹请求竞态守卫、AnswerBlock 本轮/请求口径、Sidebar token 徽标随回合刷新等
- 测试 +21：token-usage（估算/账本并发隔离/窗口收紧/键大小写）、agent-hot-reload、server done.turnUsage、agents-api reset/delete 无 body、context 会话化等；全量 778 全绿

## 1.1.0 (2026-08-30)

### 语音输入（离线 ASR）+ TTS 补齐（Sprint 43）

- **离线中文语音输入**：Web 输入区 🎤 **按住说话 → 松开识别 → 文本回填输入框**（可编辑后发送）；采集（getUserMedia + ScriptProcessor）→ 前端降采样 16k → 独立 WS 连 `/api/v1/audio` 上行 base64 PCM → 识别结果回填；录音中红点脉冲/识别中状态/错误分级提示（权限拒绝/模型缺失/识别失败）
- **ASR 服务**（`src/media/asr.ts`）：`AsrProvider` 接口 + `SherpaAsrProvider`（sherpa-onnx **paraformer-zh 非流式**，spike 实测逐字精准；懒加载 232MB 模型 + 进程内缓存）；16kHz 输入守卫（非 16k 明确报错）；`resolveAsrProvider`/`getAsrProvider` 就绪解析
- **模型管理**（`src/media/model-manager.ts`）：`data/media/models/{asr,tts}/` 就绪探测（缺失文件清单）；**hf-mirror 一键下载**（镜像实测可达，huggingface.co 直连超时；幂等跳过已就绪文件；`minSize` 处理仓库 0 字节的 `user.dict.utf8`）；CLI `/media status|download` + HTTP `POST /api/v1/media/download`（Web 设备 Tab 一键下载按钮）
- **WS 双向通道**（media-server 扩展）：`{type:"asr", audio: base64(16k PCM), sampleRate}` → `asr:result/asr:error`；一次性整段（按住说话 ≤60s）；模型未装/非 16k/坏 base64 分别明确报错；TTS 协议不变
- **TTS 补齐**：`SherpaTtsProvider` 真实现（**vits-zh-ll**，lexicon/dict/fst 内层配置，`generate()` → 16k 16-bit WAV），替换 P1 抛错桩；`resolveTtsProvider` 按模型就绪解析（sherpa 优先，edge-tts 降级保留）
- **设备 Tab 真实化**：asr/tts 状态按模型就绪动态展示 + 一键下载按钮（约 232MB ASR / 118MB TTS）
- **依赖**：`sherpa-onnx-node@1.10.46` 锁定（1.13.x 流式路径本环境原生崩溃；1.10.46 非流式全链路验证）+ `src/media/sherpa-onnx-node.d.ts` 类型声明
- 冒烟：`RUN_MEDIA_SMOKE=1` 且模型就绪时本地跑真实识别（不进 CI）
- 测试 +19（model-manager 就绪/幂等/404、asr 守卫/缓存、WS asr 协议 4 例、CLI media 3、端点 1）；全量 757 全绿

## 1.0.0 (2026-08-30)

### AI OS 1.0 整合 + 每会话项目目录（Sprint 42）

- **每会话项目目录**：`sessions` 表加 `working_dir` 列（旧库自动 ALTER 迁移）+ `getWorkingDir`/`setWorkingDir`；`/chat` 透传 `task.workingDir`（base-agent 既有优先逻辑，fs 工具/沙箱根/审批基线全链路跟随）；`GET/POST /sessions/:id/working-dir`（绝对路径+存在+目录+非 dataDir 校验，null 恢复默认，审计 `session:working-dir` + 广播）；CLI `/dir`（查看/设置/empty 恢复）；`/docs`+`/docs/content` 支持 `?sessionId=` 项目根跟随；**Web**：会话控制条 📁 徽标（**默认时显示实际默认目录名如 ai_default_project**，自定义显示目录名+「自定义」标记，tooltip 含完整生效路径与来源）+ 编辑器弹层（校验内联红字 + **「浏览…」目录选择弹窗**——浏览器无法取得本机绝对路径，故用服务端 `GET /api/v1/dirs` 只读浏览：面包屑导航/上级/子目录列表/路径跳转，选择后回填保存）、Sidebar 📁 标记、**StatusBar 移除全局 💻 工作目录**（目录已会话化，回归纯系统状态）；WS `session/update` 跨端联动
- **审计 Tab**：`AuditLog.queryRecent(limit, actionPrefix?)`（最新在前 + 前缀过滤 + limit 收敛）+ `GET /api/v1/audit`；Web SystemPanel「审计」Tab（时间/动作/目标/结果/详情/会话表格 + 应用/进化/会话/工具前缀 chips + success/blocked/error 着色）
- **设备 Tab**：`src/media/status.ts` 只读汇总三通道（ASR 未启用 / TTS engine+本地模型就绪 / 媒体服务器 WS 通道状态含连接数）+ 当前模型多模态（vision）能力；`GET /api/v1/devices`；Web「设备」Tab（通道状态卡 + 模型能力）
- **进程资源仪表**：`/processes` 附带全局 token 占用（总/入/出）；ProcessesPanel 资源条 + 每进程运行时长；顶栏 tokens/cost 即预算占用条
- **示例应用包 + .aw app 类型**：`.aw` 扩展支持 **app** 类型（打包 `data/apps/<id>/` 全目录；安装解压 → `appManager.installFromDir` 复用应用管线，临时目录自动清理，缺 app.json/appManager 明确报错）；`/pkg export app <id>`（app 仅 .aw 不支持裸导出）；`examples/` 三个高质量示例：**番茄钟**（webapp 纯前端）、**批量替换工具**（tool，能力桥 fs 实现）、**待办清单服务**（service，storage 持久化）
- **正式文档**：`docs/ai-os-architecture.md`（分层架构/进程模型/应用安全/进化闭环/会话项目目录/快速开始/目录结构）；README 更新为 1.0 徽章 + 功能矩阵
- 修复（评审）：新会话（Web 本地草稿）服务端尚无 sessions 行，保存目录报 "Session not found" → POST 时与 `/chat` 同策略 `ensureSession` 自动补建（body 带 agentId，默认 default）；CLI `/dir` 设置校验返回值；目录浏览弹窗挂载缺失修复
- 测试 +26（working-dir 端点/校验/透传/**新会话自动补建回归**/docs 跟随/迁移、**/dirs 浏览端点**、audit 查询/端点、devices 端点、示例包 6 例：导出结构/appManager 链路/缺 app.json/未注入/3 manifest 校验/webapp 结构语法）；全量 737 全绿

## 0.12.0 (2026-08-30)

### 进化引擎第三期：测试 + 推广（Sprint 41）

- **黄金用例库**（`data/evolution/cases/`）：成功会话轨迹沉淀评测用例——按 turn 提取（`turn/end reason=stop` 的 turn 取末条用户消息为 input、末条助手消息为 expected 截断 200 字符，多轮会话产出多用例，复用 `messageText` 兼容 parts 数组）；`normalizeTaskText` 完全一致去重（记 skipped）；手工补录（CLI `/evo case add <任务> [期望]` 期望为剩余参数 join + Web/API）；`/evo case list|delete|extract` + API 四端点；存储目录注入测试隔离
- **A/B 量化评测**（`evolution-eval`）：tool-fix/prompt-fix 在用例集上对比「旧文本 vs 新文本」→ 成功率/耗时报告 + 通过/回归裁决；裁判注入（生产=modelRouter 判断文本是否足以引导正确完成，输出非 JSON 抛错按用例跳过；测试 mock）；**before 双轨**（applied 走快照 `extractBefore` 现成逻辑，pending/confirmed 走实时定义 `getToolDescription`/`getAgentSystemPrompt`，按 status 选源——apply 失败残留快照不误用，旧数据无基线仅绝对线）；护栏 MAX_EVAL_CASES=5、裁判失败不计分母、**耗时仅报告不裁决**（裁判调用耗时≠工具执行耗时）、阈值含浮点 epsilon（恰等于 -0.2 不算回归）
- **推广后验证 + 自动回滚**：`/evo verify <id>` + Web「推广验证」仅 applied 可调 → 完整 A/B → regress（相对 -20% 或绝对 <50% 且 ≥2 用例）且快照存在 → **自动回滚**（`doRollback(id,"auto")` 单路径复用 rollback 状态机，审计 `evolution:auto_rolled_back` + 广播 `evolution/auto_rolled_back`，detail 含评测回归摘要）；pass/unknown 记 `verified` 不动作；无快照明确报错不虚假回滚；manual rollback 不受影响
- **API**：`GET/POST /evolution/cases`、`POST /evolution/cases/extract`、`DELETE /evolution/cases/:id`、`POST /evolution/proposals/:id/eval|verify`（POST-only 405 沿用）；台账补 `eval`/`verified` 事件（摘要含 verdict/passRates）
- **Web 进化 Tab**：提案卡片「评测」（pending/confirmed/applied）+「推广验证」（applied）按钮；A/B 结果视图（旧/新成功率对比条、✅/🔻/⚠️/⛔ 徽标、无基线/skipped 标注，报告仅当次展示重跑即刷新）；「黄金用例」卡（补录输入框/从会话提取/删除）
- **CLI**：`/evo eval <id>`（A/B 报告：成功率/Δ/裁判耗时参考/每用例明细）、`/evo verify <id>`（回归自动回滚提示）、`/evo case add|list|delete|extract`
- 修复：「从会话提取」崩溃——`user/message` 事件 data 即 Message **本体**（误按 assistant 的 `{message}` 包装解析）→ 对齐 session-store 真实形状，并对畸形/旧数据防御（形状不符按跳过处理不抛错）；测试夹具同步修正（旧夹具形状错误致漏测）
- 测试 +61（cases 提取/切分/去重/截断/形状回归、decideVerdict 阈值边界、runEval 调用次数/skipped/超限/expected 传入、engine before 双轨/eval 状态门/verify 三态/自动回滚审计广播、端点 7、CLI 7）；全量 716 全绿

## 0.11.0 (2026-08-30)

### 进化引擎第二期：补丁生效 + 快照回滚（Sprint 40）

- **快照回滚（硬能力）**：apply 写入前自动快照受影响目标（`data/evolution/snapshots/<id>.json`）——技能文件/配置 YAML/runtime-config.json 存原内容（原不存在记 null）、tool-fix 存完整 ToolDefinition（函数不可序列化，restore 时从当前注册表取 handler）；`POST /evolution/proposals/:id/rollback` + CLI `/evo rollback <id>` + Web「回滚」按钮一键还原；状态机加 `rolled_back` 终态（applied 才可回滚，回滚后再改需重新 propose）
- **tool-fix 真正生效**：meta-agent 产出改进后的工具描述（`newDescription`）→ apply 时热覆盖注册（保留原 handler，仅换 description；本次运行生效，重启回内置默认）；回滚用快照完整定义重注册
- **prompt-fix 真正生效**：meta-agent 产出改进后的完整 systemPrompt（`newPrompt`）→ apply 写 `config/agents/<id>.yaml` + `reloadAgent` 热重载（复用智能体 Tab 保存管线）；回滚恢复原 YAML + 热重载
- **技能注册表卸载**：`skillRegistry.unloadSkill(name)` 按名移除内存条目（回滚删除技能文件后同步，防残留仍被触发词激活——审核发现的漏洞）
- **台账视图**：`GET /evolution/ledger?limit=N` 返回 ledger 尾部条目；Web 进化 Tab 新增「进化台账」时间线（提议/确认/写入/回滚/拒绝/生成结果）
- **变更对比展示**（`evolution-diff`）：applied/rolled_back 提案可查看「进化前后对比」——before 从快照提取、after 从提案 action 派生，行级 LCS diff 高亮（红删绿增）；`GET /evolution/proposals/:id/change` + CLI `/evo diff <id>` + Web 卡片「查看变更」按钮；纯新增类（new-tool/new-app）显示全绿 add
- **生成结果回写**：apply new-tool/new-app 记 `generated-submitted` + jobId；index.ts 桥接 `gen/done|failed` 事件 → `onGenResult` 按 jobId 匹配提案 → ledger 记 `generated`（ok/appId）+ 广播 `evolution/generated`
- 两段式确认保留：adopt 预览新增 newDescription/newPrompt 全文；schema 强制新字段必填 + **路径穿越防护**（expert/toolName/agentId 仅拒绝 / \ ..，允许中文名）
- 修复：prompt-fix 旧格式提案（缺 newPrompt）apply 被拒不污染提示词；快照 capture/restore 越界路径拒绝（安全加固）；**config-change 白名单收紧为 temperature/maxTokens**（thinking 是内存开关不落盘、回滚无效，交配置 Tab 管理——review 发现）；diffLines/extractAfter 参数防御旧数据缺失；**tool-fix 回滚依赖 registerTool 缺失时明确报错**（不虚假成功）；Web「查看变更」支持展开/收起切换 + 加载失败提示；**skill-evolution.register 校验 reloadSkill 结果**（解析失败返回 false 并回滚文件，防技能"虚假生效"）；生成任务 **canceled** 也回写台账
- 测试 +36（snapshot 六态/restore 联动/unloadSkill/engine rollback 七例/端点 4/CLI 3/schema 4/diff 13/中文技能名/onGenResult 2/registerTool 缺失/register 2）；全量 655 全绿

## 0.10.0 (2026-08-30)

### 进化引擎第一期：观察 + 提议（Sprint 39）

- **观察层**（`evolution-observer`）：从 `session_events` / 审计派生进化指标，不新增存储——工具成功率/耗时/失败 top 错误（按 callId 配对）、任务完成率（turn/end reason）、重复任务聚类（首条用户消息前缀相似度，≥3 次提示）、用户干预频率、生成统计；窗口最近 7 天；会话列表放大 limit（≥500）防窗口截断；空数据短路跳过 LLM 省预算
- **提议层**（`evolution-proposer`）：meta-agent 分析观察数据 → 单条结构化提案（new-skill / new-tool / new-app / config-change / tool-fix / prompt-fix），schema 校验 + 解析失败重试 ≤2 次；提案落盘 `data/evolution/proposals/` + `ledger.json` 台账；**每日 ≤3 条限频护栏**
- **采纳/拒绝**（`evolution-engine`，**两段式确认**）：`adopt` 仅确认提案内容（pending→confirmed，返回写入预览，**不写入任何内容**）；`apply` 才真正执行（confirmed→applied）——new-skill 复用 skill-evolution 校验注册（meta-agent 直接产出 SKILL.md）、new-tool/new-app 复用生成队列（与对话生成同队列串行互斥）、config-change 走配置通道（白名单字段）、tool-fix/prompt-fix 仅记录建议人工执行；`reject` 可从 pending/confirmed 撤销；幂等（各状态机非法流转拒绝）；全审计 + `evolution/*` WS 事件
- **API**：`GET /evolution/observe`、`POST /evolution/propose`、`GET /evolution/proposals`、`POST /evolution/proposals/:id/adopt|apply|reject`（adopt 返回 preview）
- **Web「进化」Tab**：观察指标仪表（成功率条/失败错误 chips/重复任务/生成统计）+ 提案卡片（类型徽标/风险）；采纳后展开**写入预览**（SKILL.md 全文/配置值等）→「确认写入」/「撤销」二次确认；采纳 new-tool/new-app 反馈 jobId 并引导「应用」Tab
- **CLI `/evo`**：observe / propose / list / adopt（预览）/ apply（写入）/ reject
- **修复 web tsc 3 存量错误**：`chat.svelte.ts` pendingTools 判空、`markdown.ts` marked v15 API 变更（highlight 选项移除 → renderer 扩展、parse 同步断言）；web tsc 首次 0 错误
- **数据核查**：`data/docs` 文件名为正确 UTF-8（此前"GBK 乱码"为 PowerShell 控制台显示假象，全目录扫描无乱码，无需修复）
- 测试 +40（观察聚合/窗口/空数据、提议 schema/限频/重试、两段式确认全状态机、端点 7 例、CLI 7 例）；全量 602 全绿

## 0.9.2 (2026-08-30)

### 文档预览支持工作目录项目文档（Sprint 38）
- **双来源**：文档预览面板分组展示「会话资产」（`data/docs/`）+「项目文档」（工作目录 `*.md`，mtime 降序，AI 刚写的排最前）
- **项目扫描防噪音/防性能**：排除 `node_modules/.git/dist/.venv/__pycache__` 等系统目录与应用自身 dataDir（按绝对路径）；深度 ≤4、.md ≤200、单文件 ≤1MB
- **API**：`/docs` 返回 `roots` + `docs[{root, path, title, size, mtime}]`；`/docs/content?root=session|project` 各自独立路径穿越防护（无 root 参数兼容旧行为）
- **前端**：`docViewer` 改为 `root:rel` 前缀 key；预览面板分节 chips（项目文档用相对路径做标题）+ 手动刷新 + 监听 `session/update` 自动刷新；图表 sidecar（`data.json`）仅会话资产加载，避免误读项目业务 JSON；路径统一正斜杠（Windows 兼容）
- **布局优化**：文档预览改**左侧垂直文档栏**（会话资产/项目文档分组、sticky 标题、当前文档高亮、可收起给渲染区让位）＋右侧渲染；渲染区无标题时自动隐藏目录列
- 测试 +3（双来源扫描/排除、project 读取与穿越防护、session 兼容）；全量 556 全绿

## 0.9.1 (2026-08-30)

### Web 对话技能模式 + 技能检索（Sprint 37）
- **技能模式**：Web 输入 `/技能名 任务` 等价 CLI `/技能名` 激活技能（兼容 `/skill <名称>` 形式）——技能正文注入系统提示（`Task.explicitSkill` → context 组装，仅当轮上下文，不进会话历史），指令保持原始输入；SSE 新增 `skill_activated` 事件，助手消息顶部显示 `⚡ 技能名` 徽标
- **技能检索**：输入框以 `/` 开头弹出技能选择器（名称/描述/专家/触发词实时过滤，↑↓ 高亮、Tab/点击插入、Esc 关闭），配置条新增「技能」按钮一键唤起；系统设置「技能」Tab 增加搜索框
- **未知技能兜底**：`/xxx` 未命中时 SSE 发 `skill_not_found`（含可用技能列表），不建会话、不跑智能体、不落库
- **修复 /chat 用户消息双写**：server.ts 与 base-agent 各 append 一次用户消息导致服务端会话重复（turnCount 翻倍、清缓存刷新可见重复）——持久化收敛到 base-agent 唯一入口
- 测试 +5（技能激活/未知技能//skill 形式/非斜杠消息不受影响/双写回归）；全量 548 全绿

## 0.9.0 (2026-08-30)

### 多模态 + 应用工坊 + 智能体管理（Sprint 36 及后续迭代）
- **多模态图片**：对话支持粘贴/选择图片上传（`Message.content` 联合类型、`Task.images`、`/chat` vision 门控——当前模型不支持视觉时明确提示配置 `vision:true`）；后端 TTS 音频通道（`/api/v1/audio` WS，edge-tts 自研客户端；语音输入受网络限制放弃，保留图片能力）
- **「应用工坊」任务模式**：输入区任务类型下拉新增第三项——对话直接触发应用生成（后台队列，不阻塞对话）；聊天流**实时状态卡片**（排队→生成中步骤/百分比/文件明细→完成+打开应用/查看文档→失败原因），与按钮生成（GenWizard 简化后）统一走聊天流卡片
- **生成卡片持久化**：终态（done/failed/canceled）写入卡片消息（`_genStatus/_genResult/_genError`），刷新/重开会话仍可恢复展示；`GET /api/v1/apps/gen` 列表端点 + 前端拉取恢复进行中任务
- **能力桥修复**：宿主回发 `bridge:res` 的 targetOrigin 改 `"*"`（沙箱 iframe origin 为 "null"，原传宿主 origin 被浏览器静默丢弃导致 30s「宿主无响应」）；`http.fetch` 加 10s 超时 + 明确错误；webapp 生成模板明确桥接返回契约（`{status, ok, text}`）；天气应用 httpGet 解析修复
- **智能体管理（二期完整版）**：系统设置新增「智能体」Tab——内置 7 专家查看/编辑 System Prompt 与参数（写 `config/agents/*.yaml` **热生效**，恢复默认一键回 TS）；**自定义智能体**（GenericAgent + YAML，与内置同等待遇：执行专家下拉/对话/团队协作/jobRunner 均可用），支持自定义 prompt/模型/迭代/工具白名单 + **技能绑定**（运行时注入，更新即时生效）+ **MCP/插件绑定**（保存展开进白名单）+ **严格工具模式**（关闭 mcp/插件全局豁免）；`/agents/meta` 表单选项端点 + config/reset/delete 端点
- **迭代上限收敛**：唯一事实源改为 `config/agents/*.yaml`（智能体 Tab / CLI `/config iterations` 同机制持久化），移除 runtime-config 运行时覆盖（消除两处配置冲突）
- **日志并入轨迹 Tab**：上部「最近活动」（跨会话 turn 汇总，今天/昨天/日期分组，点击直达）→ 下部「会话轨迹」（默认跟随当前会话，可固定目标会话）；「日志」Tab 移除
- **会话列表统一**：移除「应用生成」独立分区（生成过程已在对话流卡片），appgen 后台会话不再展示
- **修复**：Svelte 5 深响应代理回写（生成卡片 `_genJobId` 原直接改局部对象不触发更新）、生成卡片跨会话终态定位、AgentsPanel 挂载漏加载、智能体保存丢失 allowedTools/deniedTools、技能段 marker 定位替换防重复/防 YAML 固化
- **README**：界面预览补全 7 张截图（修复 web_ui_demo1 双后缀断链）
- 测试 +15（agent-config-loader roundtrip、agents API CRUD、GenericAgent 技能注入、media 音频、CLI iterations 持久化）；全量 543 全绿

## 0.8.0 (2026-08-27)

### AI OS 应用工厂 v2 + 窗口体系 + 应用预览面板（Sprint 35）
- **应用工厂 v2（生成管线重构）**：复用 agent-loop + fs_write/fs_edit 工具生成应用（与智能体对话写文件无区别）——构造临时「生成 agent」（tools 白名单 fs 四件套、modelPreference coding、迭代上限 30），多轮工具调用写文件，彻底删除 v1 的分块续写/拼接逻辑；校验器最终把关（app.js 语法/引用/manifest 白名单/入口存在）+ 反馈 LLM 自查再修（≤2 轮）
- **新工具 `fs_edit`**：局部修改（文本唯一匹配 或 行号区间 startLine/endLine 替换/删除），`fs_read` 支持 `lineNumbers:true` 输出行号；变更面板因此能显示**删除行**（之前仅新增）
- **窗口体系**：三形态（panel 停靠预览 / float 浮窗 / widget 透明小部件）+ 拖拽（pointer capture）/缩放/置顶 + 形态互切（停靠↔浮窗↔小部件）+ widget 透明背景框架级保证（宿主注入 `background:transparent!important`）+ 位置/状态持久化
- **右侧面板「应用预览」Tab**：新生成应用/文档默认停靠展示（自动展开面板），应用名 + 版本 + 浮窗/小部件/关闭按钮；文档 Markdown 渲染（标题目录点击定位 + 滚动跟随 + 图表）；文档浮层随时可重新打开历史文档
- **能力桥**（宿主注入 C 方案）：`window.__AIWORKER_BRIDGE__`（storage/notify/llm/fs/http）+ `/apps/:id/bridge` 端点；沙箱 iframe 消息按 `ev.source` 身份校验（origin 为 "null" 无法用 origin 校验）+ 请求 30s 超时；webapp manifest 按模板白名单写入权限（能力桥"直接用"契约成立）
- **异步生成队列**：`generator-queue`（jobId 即返、状态流转、取消排队任务、gen/* 事件、完成态保留 20 条）+ GenWizard 进度条 + 轨迹时间线（agent-loop 工具事件驱动）+ 生成中可随时关闭（后台继续）
- **会话展示**：左侧会话列表上下分栏（上栏正常会话 / 下栏「应用生成」独立分区）；appgen 会话可读标题（`应用生成: xxx`）；自动切换跳过 appgen 会话
- **文件变更面板**：指纹监控「新增文件」快照展开为全新增行（行号 + 绿色标识）；「当前内容」视图补行号；自动刷新后按 path 重映射选中
- **update() 健壮性**：同应用并发互斥（串行化）、agent 运行后存在性复核、reload 先于重启（新工具声明生效）、start 失败清理、semver 版本递增、style.css-only 变更检测
- **进程列表修复**：服务器重启恢复的 running 应用补注册进程（幂等短路补 `registerAppProcess`）；进程展示应用名；状态栏 Cpu 计数含 app 进程、cost 按 prompt/completion 分价
- 测试 +33；全量 524 全绿（含 v2 生成全链路 mock、fs_edit 双模式、恢复进程注册、widget 透明注入、新增文件展开）

## 0.7.0 (2026-08-26)

### AI OS 内核：应用模型 + 进程模型（Sprint 34）
- **应用模型**：`data/apps/<id>/app.json` manifest（tool/skill/agent/service 四类；webapp Sprint 35）+ schema 校验（**terminal 权限禁用**、fs 权限限沙箱内、entry 防穿越、工具声明校验）+ 生命周期状态机（installed→starting→running→stopping→stopped / destroyed）+ state.json 持久化 + **autostart 启动自动拉起** + destroy 幂等（代码/进程/权限/审计全清）
- **子进程能力桥**（`app-runtime`）：tool/service 应用**不进程内加载**——`child_process` + `--max-old-space-size=256` + 行分隔 JSON-RPC；能力 API（storage/notify/llm/fs/http，**无 terminal**）；60s 工具超时、stdout 截断、15s 心跳、**崩溃指数退避重启**（1s/2s/4s ≤3 次）；能力权限强制层（sandbox.checkAppCapability：storage 自动允许，其余静态声明命中，未命中走 ask 通道 fail-closed）
- **进程模型**：`process-manager` 统一 Agent/App/Job 注册表 + 事件广播（`process/*`）；agent-loop / job-runner / app-manager 登记；`/api/v1/processes` 实时视图
- **CLI `/app`**：list / info / install（目录）/ start / stop / destroy（二次确认）
- **HTTP**：`GET/POST /api/v1/apps`、`POST /api/v1/apps/:id/start|stop|destroy`；WS 事件 `app/*` 实时刷新
- **插件兼容**：现有 config/plugins/ 插件展示为 tool 类应用（list 合并视图，plugin-manager 零改动）
- **Web UI 升级**：暗色模式（顶栏开关 + localStorage + 跟随系统）、lucide 图标统一、细滚动条、`:focus-visible`、空状态启动台（新对话/生成应用/查看进程/语音）、左侧 OS 导航（对话/应用/进程/任务/设置）、StatusBar 进程/应用计数、SystemPanel 新增「应用」「进程」Tab、应用面板生命周期操作 + 销毁确认
- **依赖**：better-sqlite3 11→12.11.1（Node 24 ABI 兼容）、lucide-svelte 1.0（Svelte 5 兼容）
- 测试 +35（manifest/app-manager/app-runtime/process-manager/apps-api 端点）；全量 492 全绿

## 0.6.6 (2026-08-23)

### 高危拦截加固 + 工具错误展示/重试优化
- **danger-detector 正则加固**（修复绕过漏洞）：`rm -rf` 拦截任意目标（相对路径/引号路径/盘符）；全部匹配大小写不敏感（`RM -RF` 不再绕过）；`del` 的 `/s /q` 任意顺序；`rd`/`rmdir` /s 别名覆盖
- **Web 工具卡片区分「操作被拦截 / 执行失败」**：不再把所有 error 统一标成"被拦截"（如 `Select-Object is not recognized`、`Command failed` 实为命令执行失败）
- **重试按钮修复**：流式输出期间点击不再静默无响应（提示"当前正在生成中"）；拦截类错误附注引导 LLM 更换实现方式，执行失败附注引导修正后重试
- **terminal_exec 描述补充**：Windows 下命令在 cmd 执行，PowerShell 语法需 `powershell -Command` 包裹
- **文件变更列表区分"已修改"**：指纹监控修改已有文件（无行级 diff）不再显示误导性的 `+0 -0`，改显示「已修改」徽标（`DiffFile.modified` 字段）
- **terminal_exec 报错保留真实原因**：命令 `2>&1` 时 stderr 并入 stdout，错误详情回传 stdout 尾部（而非笼统 `Command failed`）；exec 环境显式补入 node 目录（修复 server 缺 PATH 时 `'node' is not recognized`）
- **文件变更支持删除检测**：指纹反向对比发现删除 → `deleted` 标记 + Web「已删除」徽标
- **旧格式快照兼容推断**：无标记历史快照按 diff 文本 + 文件当前状态推断（已删→已删除、无标记→已修改、新增行数从文本提取），不再显示 `+0 -0`
- **移除 GitHub Actions CI**（`ci.yml` 频繁失败、用处不大），README badge 与 AGENTS.md 同步清理
- 测试 +6（rm 绕过用例 5 + legacy 推断 1）

## 0.6.5 (2026-08-23)

### 文件变更检测提速 + terminal_exec 用途明确
- **指纹扫描只在「可能写文件的工具」后触发**（terminal_exec / terminal_session / MCP / 插件工具），只读工具（web_search/fs_read 等）不再全量扫描
- **扫描范围分层**：跳过机器生成目录（`.godot`/build/out 等）；用户资产文件（.glb/.png 等）仍检测变更，但快照降级为元信息（`binary: 1` + 大小，不读全文不 base64），前端显示「二进制文件已变更（内容不可预览）」
- **会话级节流**：同一会话两次指纹扫描间隔 ≥2s（`scanThrottleMs` 可注入，测试用 0）
- **/diffs 签名缓存**：快照目录文件数 + mtime 未变时直接返回缓存，避免每次请求全量解析
- **terminal_exec 描述重写**：明确写文件用 fs_write、禁止 shell 重定向写文件；fs_write 描述补充「首选本工具」；coding/default/data-analysis/game-dev 4 个 agent 提示词同步
- 存量清理：删除 Godot 引擎缓存噪音快照 11817 个（16484 → 4667）
- 测试 +3（binary 解析 + /diffs 缓存行为；hooks 指纹测试适配节流注入）

## 0.6.4 (2026-08-22)

### 添加模型 / Provider（TUI + Web）
- **`ModelRouter.addProfile`**：运行时动态添加模型 profile（key 唯一校验、缺 model/baseURL 拒绝、继承默认 provider/apiKey/temperature/maxTokens），立即可切换
- **CLI `/config add-model <key> <模型名> <baseURL> [provider] [apiKey]`**：添加并持久化到 `config/models.json`（保留 default/pricing/routing 等原有字段）
- **Web 配置 Tab**：新增「添加模型 / Provider」表单（key/模型名/baseURL/provider/apiKey，apiKey 建议 `${ENV}` 引用）→ `POST /api/v1/config` field=`addModel`
- 测试 +2（addProfile 单测 + addModel 端点持久化）

## 0.6.3 (2026-08-22)

### TUI 会话导出 + Web 系统配置
- **TUI `/export [序号]`**：导出会话为 Markdown 文件（默认当前会话，`/export <序号>` 按 `/sessions` 序号；写入工作目录 `<标题>.md`）；渲染逻辑与 Web 共用（`memory/session-export.ts` 抽取）
- **Web 系统配置**（SystemPanel 新增「配置」Tab，等价 TUI `/config`）：模型下拉 / 温度 / max-tokens / **每专家迭代上限** / 思考展示开关 / 技能自动沉淀开关 / 恢复默认（reset）；设置持久化 `data/runtime-config.json`
- HTTP：`GET/POST /api/v1/config`（`setConfigField` 由 index.ts 注入，复用 modelRouter/agents/hookManager/persistRuntimeConfig）
- `persistRuntimeConfig` 提升为 server 与 CLI 共用闭包
- 测试 +5（/export 2 例 + config 端点 3 例）

## 0.6.2 (2026-08-22)

### 帮助系统精简
- `/help` 表格精简为两列（命令+别名 / 一句话功能），长 usage/detail 不再撑宽表格
- **命令级帮助**：`/<命令> --help`（或 `-h`/`help`）显示该命令的 用法/功能/说明/别名；`/help <命令>` 等价；**必选参数命令无参数时自动显示帮助**
- `/help <命令>` 查看指定命令详细用法

## 0.6.1 (2026-08-22)

### 裸格式导入导出（除 .aw 外）
- **导入**（`/install <路径>` 自动识别 + Web 导入按钮接受 `.md`/`.json`）：
  - `SKILL.md` → 解析 frontmatter 装到 `skills/<name>/`（附 manifest.json）
  - MCP 配置 `.json` → 文件名作服务器名合并 `config/mcp.json`
  - 插件目录 → 入口探测后拷贝到 `config/plugins/<name>/`
- **导出**（`/pkg export <类型> <名称> --raw` + Web「导出 .md/.json」按钮）：技能 → 裸 `SKILL.md`；MCP → 裸 server 配置 JSON；插件 → 复制目录（CLI）
- HTTP：`/packages/peek` 与 `/packages/import` 支持裸格式（`filename` 分发）；`/packages/export?raw=1`
- 测试 +7（installer 裸格式 7 例 + cli/server 裸格式用例）

## 0.6.0 (2026-08-22)

### .aw 资产包导入导出（技能 / MCP / 插件）
- **统一分发格式 `.aw`**（zip + manifest.json）：`scripts/pack-aw.mjs` 打包脚本 + `src/core/zip.ts`（零依赖 zip 读写，deflate/store）+ `src/core/package-installer.ts`
- **支持三类型**：`plugin` → `config/plugins/<name>/`（入口校验 + 回滚）、`skill` → `skills/<name>/SKILL.md`（frontmatter meta 读取）、**`mcp` → 合并条目到 `config/mcp.json`（冲突需确认）**
- manifest 校验：formatVersion / type / 包名白名单 / semver / minAppVersion；**路径穿越防护**（相对路径校验 + 解压后入口探测，失败回滚）
- **CLI**：`/install <path> [-f]`（安装）、`/pkg export <skill|mcp|plugin> <名称> [路径]`（打包导出）、`/pkg list`（可导出 + 已安装）
- **HTTP**：`GET /api/v1/packages/export`（下载 .aw）、`POST /api/v1/packages/peek`（导入前预览 manifest 供安全确认）、`POST /api/v1/packages/import`（base64 上传）、`GET /api/v1/packages/list`
- **Web**：系统面板技能/MCP/插件三 Tab 均支持导入（.aw 文件选择 → peek 确认 → 安装）与导出（下载 .aw）；插件/MCP 导入前弹安全警告
- 测试：installer 22 例（zip round-trip / mcp 安装冲突导出 / 路径穿越 / 回滚）+ cli/server 端点覆盖

## 0.5.1 (2026-08-22)

### 定时调度自然语言添加
- **自然语言解析**（`src/core/nl-schedule.ts`，规则优先）：每 N 分钟/小时、每天/每晚、每周X（含"每周一到周五"区间）、每月X号、每工作日/每周末；时间词（凌晨~午夜，下午/晚上 +12 小时）+ 整点/半点/X点X分/X:XX
- `/schedule add "每天早上8点生成早报"` 直接可用；规则解析失败时 **LLM 兜底**（few-shot 转 JSON，cron 合法性校验）
- `POST /api/v1/schedule` 支持无 cron 自然语言；Web 调度 Tab 增加自然语言输入框（cron 填写降为可选项）
- 无时间无频率的文本（如"帮我写个程序"）正确拒绝，不再误解析为每天任务

### 会话轮数修正
- `listSessions` 新增 `turnCount`（用户消息条数）；Web 侧边栏与 TUI `/sessions` 均显示真实轮数（修复"0 轮"）

### Web UI 优化
- 「系统」面板改左右布局（左侧菜单 + 右侧内容）
- 「文件变更」：目录树单目录独立折叠（$derived 自动追踪 + 按会话隔离）、列表拖拽滚动、diff 行号/符号不可选 + 点击行复制

## 0.5.0 (2026-08-22)

### 后台任务 + 定时调度
- **JobRunner**：`/bg <任务>` 后台执行不阻塞交互；状态机 queued→running→done/failed；并发上限 2（超出排队）；结果写独立会话 + 审计 + **WS `job/done` 实时推送**；后台任务不注册确认通道（fail-closed 自动拒高危）
- **Scheduler**：`config/schedule.json` 定义 cron 任务（cron-parser，5 字段标准 cron），到点自动提交 JobRunner；无效 cron 跳过记审计；支持 `/schedule` 命令与 HTTP 端点
- CLI：`/bg` / `/jobs`（含 cancel）/ `/schedule`（list/add/remove）
- HTTP：`GET/POST /api/v1/jobs`、`DELETE /api/v1/jobs/:id`、`GET/POST /api/v1/schedule`、`DELETE /api/v1/schedule/:id`
- Web SystemPanel 新增**调度 Tab**：定时任务增删 + 后台任务状态（WS 驱动实时刷新）

### 首次运行引导
- **`.env` 加载**（`env-loader`，零依赖）：KEY=VALUE 注入 process.env（不覆盖已有变量、BOM 容错）
- **三步引导**：TUI 模式 + 无 DEEPSEEK_API_KEY + 未完成过时触发——输入 API Key（写 `.env` 立即生效）→ 选权限模式（写 `permissions.json`）→ 确认目录；`/setup` 随时重进；`--server` 模式跳过

## 0.4.0 (2026-08-22)

### 迭代预算管理
- **默认上限扩容**：default 30→60 / coding 50→100 / product-ops 40→80 / financial 60→120 / data-analysis 60→120 / game-dev 70→140 / research 80→160（`config/agents/*.yaml` + default TS）
- **运行时可调**：`/config iterations <10-1000>` 设置当前专家上限，持久化 `data/runtime-config.json`（`iterations` 字段，启动自动恢复；向后兼容旧文件）
- **预算感知收尾**：剩余迭代 ≤5 轮注入一次收敛提示；撞顶不再裸返回"达到迭代上限"，改为返回最后进展 + 建议（继续追问或 /plan 拆分）
- **空转强制终止**：连续相同 (tool, args) ≥6 次强制终止（提醒阈值 3 之上），报告进展
- **工具全失败终止**：连续 4 轮全部工具调用失败提前终止

## 0.3.0 (2026-08-15)

### 执行沙箱（对比报告 #3）
- **策略化命令沙箱**：`config/sandbox.json` + `src/security/sandbox.ts`
  - cwd 越界约束（fail-closed）：`terminal_exec` 工作目录必须位于 workingDir/allowDirs 内
  - `denyCommands` 配置化命令黑名单（叠加 danger-detector 正则层）
  - `stripSecretEnv`：执行时剥离含 KEY/TOKEN/SECRET/PASSWORD 的环境变量
- 接入 `terminal_exec` 与 `terminal_session`（spawn env 清理 + exec 前策略检查）
- 说明：不做 OS 级进程沙箱（bwrap/restricted-token）——Node 无原生 API、信任模型为本人执行

### WebSocket 实时总线（对比报告 #8）
- `EventBus` 事件总线 + `GET /api/v1/ws`（ws 包，心跳 30s 清理死连接）
- chat/plan/debate 事件 SSE 与 WS 双写广播；会话创建/重命名/删除/新消息广播 `session/update`
- Web UI WS 连接 + 指数退避重连：会话列表/消息多标签页实时同步（SSE 仍为单次任务主通道，双通道不重复渲染）
- vite dev proxy 支持 WS 转发

### CI / 测试
- **GitHub Actions**：`.github/workflows/ci.yml`（windows + ubuntu 双平台：lint + build + vitest + web:build）
- npm scripts 跨平台化（cross-env 替代 Windows `set` 语法）
- 测试与真实配置解耦：`test/fixtures/models.json`（ModelRouter 注入 fixture，改配置不再碎测试）
- terminal-session 测试平台守卫（非 Windows 跳过）
- 新增沙箱 9 例 + WebSocket 4 例，共 **345 测试**

### 其他
- `config/models.json`：default profile 移除冗余 temperature/maxTokens；lite 本地模型更新（Qwen3.8-27B-UD-IQ2_XXS, 4096）

## 0.2.0 (2026-08-15)

### 插件系统与工具作用域（Sprint 27）
- **轻量插件契约**：`config/plugins/<name>/` 每目录一插件（`plugin.ts|js` 默认导出 `setup(ctx)`，可选 `config.json`），零框架依赖
- `PluginContext`：`registerTool(..., {scope?})` / `registerHook` / `config` / `dataDir`
- **scoped 工具注册**：`ToolRegistry.getScope()` 作用域视图（同名遮蔽全局），agent 按专家隔离工具可见性
- 插件工具豁免可见性白名单（即插即用，与 `mcp_` 同待遇）；`mcp_` 前缀工具始终全局可见
- `/plugins` 命令 + `GET /api/v1/plugins`；同名冲突 ⚠ 警告
- **Hook fail-soft**：插件 hook 抛错不中断任务（记审计视为放行，权限用显式 `{proceed:false}`）

### 对比报告落地（Sprint 23-26）
- **LLM Provider Seam**：`LlmAdapter` 契约 + 稳定错误码 + adapter 注册表（未知 id 降级 openai-compatible）
- **事件溯源会话**：`session_events` 仅追加日志唯一真源，消息/轮次/工具/记忆均为投影，replay-safe
- **轨迹/遥测**：`/trace` 事件级时间线 + 会话统计；TelemetrySink seam + JSONL 导出
- **审批服务**：`ApprovalService` 权限决策单点（ask/plan/auto 三模式矩阵，fail-closed），权限 hook 薄委托
- **超长工具结果落盘**（spill）：>8000 字符写入 `data/spills/` 返回定位符
- **工具调用统一超时**：默认 60s 护栏
- **ask_user 提问工具**：TUI 输入行 / Web 提问卡片 / 单选多选 / 30s 超时
- **持久终端会话**：`terminal_session` 跨调用保留 cd/env，超时销毁防缓冲区错位
- **防循环提醒**：连续 ≥3 次相同 (tool, args) 注入 system 提醒
- **会话自动标题**：首条用户消息生成（≤24 字符，不覆盖手动重命名）
- **工具结果剪枝**：上下文组装前截断 >20K 字符 tool 消息（事件日志完整，replay-safe）

### TUI / Web
- TUI 输入行多行支持（Shift/Alt/Ctrl+Enter 换行）、流式 Markdown 表格对齐、硬件光标定位
- ask_user 交互：状态栏「等待你的回答」、↑/↓ 选项导航、Tab/空格 勾选（多选）
- TUI 会话切 Web 后工具时间线完整重建（`replayEvents`）
- Web：AskCard 选项逐行/复选、SystemPanel 插件 Tab

### 其他
- **版本机制**：`package.json` 单一版本来源（`getAppVersion()`），`--version` / Banner（动态居中）/ `/status` / `/api/v1/status` 统一
- 启动横幅精简：统一状态区（✓ 模型/专家/工具/插件/技能/项目），告警置状态区后
- 项目类型「未识别」展示友好化（unknown → 未识别，无逗号空洞）
- `/status` 命令显示版本 + 7 专家列表

## 0.1.0

- 初始版本：7 专家路由 + 工具/MCP + Skills + Hooks + 三层记忆，TUI 终端与 Web UI 双界面
