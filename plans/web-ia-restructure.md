# Web 信息架构重构：设置 / 控制台分离（右栏收敛 + 安全面补齐）

> 起因：用户提问「为何将『权限』功能放在右侧面板中，而不是放在『设置』中？当前 Web UI 中所有功能的布局、位置是否合理」。
> 本文只描述**结构与归属**的改造，不改任何判定逻辑；所有"生效时机"都逐条核实过代码，不靠推测。

## 〇、目标与判据

**一句话**：把 `⚙` 里 13 个 tab 的"设置 + 观测 + 资源 + 系统"混装，拆成两个有明确语义的入口——**设置**（会写配置、改变行为）与**控制台**（观察系统、以只读为主）；把右栏「权限」搬进设置；并把**只能改文件、Web 完全看不到**的三个安全面（沙箱目录 / 受保护路径 / 永不自动批准）补齐。

判据（三条，缺一不算完成）：
1. **归属可一句话说清**：每个 tab 都能回答"它会改什么、写到哪里"；
2. **零丢失**：现有 13 个 tab 逐条有归宿（见 §二 映射表），不允许"顺手砍掉"；
3. **写面三件套**：任何新增的可写面都必须有 ①写入门（跨站 403 → token 401 → 参数 400）、②原子写、③**生效时机**的用户可见说明，并有单测覆盖。

## 一、现状诊断（实读代码，非推测）

**入口与结构**
- `⚙` 有两个入口：`Sidebar.svelte:137`（底部"设置"）与 `TopBar.svelte:23`；都打开同一个模态 `App.svelte:159`，里面是 `SystemPanel.svelte`。
- `SystemPanel.svelte:13` 一个类型里塞了 13 个 tab：`context / agents / skills / mcp / plugins / apps / processes / devices / evolution / schedule / config / audit / trace`。
- 右栏三个 tab：`App.svelte:137-146`：产物 / **权限** / 应用；`rightTab` 类型见 `lib/stores/apps.svelte.ts:64`。

**问题（按严重度）**

| # | 问题 | 证据 |
|---|---|---|
| G1 | **"设置"名不副实**：13 个 tab 里只有 `config` 一个真正写配置，其余是观测（context/trace/audit/evolution）与资源（agents/skills/mcp/plugins/apps/processes/schedule），语义混装 | `SystemPanel.svelte:695-707` |
| G2 | **权限被放在"观察"区域**：权限规则是**会写文件**的配置（`config/permissions.json`），却挂在右栏（与产物/应用并列），既不是"看产物"也不是"看应用" | `App.svelte:140`、`PermissionsPanel.svelte:57` |
| G3 | **三个安全面 Web 完全看不到**：① 沙箱目录（`config/sandbox.json` 的 `allowDirs / allowWriteDirs / allowReadDirs / denyCommands / stripSecretEnv`）**没有任何 HTTP 端点**；② `protected_paths`；③ `never_auto_approve`。只能手改文件，且改错没有反馈 | 路由清单里无 `/sandbox`；`PermissionMemory` 只管理 `rules`（`src/server.ts:1228-1281`） |
| G4 | **模型配置与设备面板分家**：`config` tab 管模型选择/温度/maxTokens，`devices` tab 却显示"模型能力/窗口/视觉来源"——同一件事两处看 | `SystemPanel.svelte:1042-1056` vs `:784-804` |
| G5 | **文案指向不存在的路径**：图片输入被拒的提示写着「请在 Web『设置→设备→模型能力』点【检测图片能力】实测」——当前 IA 里没有这条路 | `src/server.ts:2349` |
| G6 | **一个死配置可能被写进 UI**：`permissions.json` 的 `allowed_dirs` 只有定义、**零调用方**（`isDirAllowed` 全仓仅自身一处匹配）→ 若照搬进设置页，等于给用户一个假开关 | `permission-model.ts:233` |

## 二、目标 IA（映射表：旧 → 新，逐条不漏）

**设置（Settings）**——"我会改东西"：

| 新 tab | 内容 | 来源 |
|---|---|---|
| 模型 | 当前模型 / 温度 / maxTokens / 添加模型 | `SystemPanel` 的 `config` tab（`1042-1084`）**抽出** |
| | 模型能力卡（模型、provider、视觉能力+来源、窗口、端点、adapter、思考、探测按钮） | `SystemPanel` 的 `devices` tab 的模型卡（`784-804`）**抽出** |
| 安全 | 权限规则（列表 / 添加 / 撤销 / 清空，含来源标注） | 右栏 `PermissionsPanel.svelte` **整体搬入** |
| | 受保护路径 `protected_paths`（新增） | 新端点（§三） |
| | 永不自动批准 `never_auto_approve`（新增） | 新端点（§三） |
| | 命令黑名单 `denyCommands` + 敏感环境变量清理 `stripSecretEnv`（新增） | 新端点（§三） |
| | 当前权限模式（**只读**展示 + 说明用 `--mode` / `default_mode` 修改） | 不新增运行时切换（现无端点，见 §七） |
| 工作区 | 当前会话工作目录（只读 + 目录选择器） | 复用 `GET /api/v1/dirs`（`server.ts:1012`） |
| | 沙箱根：`allowDirs`（工作目录根）/ `allowWriteDirs`（写根）/ `allowReadDirs`（读根）（新增） | 新端点（§三） |
| 交互 | 思考展示 `thinking`、技能自动沉淀 `skillEvo`、主题 | `config` tab（`1057-1062`）+ 既有主题 store |
| 关于 | 版本 / 数据目录 / 存储（SQLite + FTS5 实测）/ 运行时 / 配置文件路径 | `devices` tab 的运行时与存储部分 |

**控制台（Console）**——"我只想看"：

| 分组 | tab | 来源 |
|---|---|---|
| 观测 | 上下文 / 轨迹 / 审计 / 进化 | 原样（`SystemPanel` 对应分支不动） |
| 资源 | 智能体 / 技能 / MCP / 插件 / 应用 / 进程 / 调度 | 原样 |
| 系统 | 设备与运行时（ASR / TTS / 媒体服务器 / 存储 / 运行时，**模型能力卡只读**） | `devices` tab 余下部分 |

**右栏**：`产物 / 应用`（2 tab）；`rightTab` 类型去掉 `"permissions"`。

**导航呈现**：控制台左导航加分组标题（观测/资源/系统）+ 一道分隔线；设置左导航 5 项。分组只是**视觉分组**，不改任何 tab 内部实现。

**发现性补偿**（删掉右栏权限 tab 的代价）：`StatusBar` 增加「权限模式」徽章，点击直达 设置→安全；确认弹窗内保留「始终允许」写入并提示"可在 设置→安全 撤销"。

## 三、后端改动

### 3.1 新增 `GET/POST /api/v1/sandbox`
- **GET** → `{ path, enabled, allowDirs, allowWriteDirs, allowReadDirs, denyCommands, stripSecretEnv, effective: { allowDirs: [...绝对路径], ... } }`（`effective` = 按 `resolveRoots` 展开后的**真正生效值**，留空即"回退工作目录"，必须让用户看到这个回退结果）。
- **POST** → 整对象写入 `config/sandbox.json`（保留文件里的未知键，与 `permission-memory` 同样的原子替换：临时文件 + `rename`，保留 BOM）。
- **校验（400）**：类型必须对（布尔/字符串数组）；目录必须**绝对路径**（相对路径在 `loadSandboxPolicy` 里按 cwd 解析，Web 端语义含糊 → 直接拒绝，附原因）；`denyCommands` 拒绝空串与含换行。
- **生效时机：立即生效**——已核实 `loadSandboxPolicy()` 在**每次工具调用**时现读磁盘（`src/tools/builtin.ts:27 / 437 / 754`），不需要重启。UI 文案照实写"已保存，下一次工具调用即生效"。

### 3.2 扩展 `/api/v1/permissions`
- **GET** 增补：`protectedPaths`（**当前生效清单**）、`protectedDefaults`（内置基线，来自 `DEFAULT_PROTECTED_PATHS`）、`neverAutoApprove`、`mode`、`defaultMode`、`sandboxPath`。
- **POST** 新增 `action`：`set-protected-paths` / `set-never-auto-approve`（整表替换，逐条校验非空字符串）→ 写文件**并同步更新运行中的 `PermissionModel`**。
- 需要给 `PermissionModel` 增加两个 setter（沿用既有归一化：小写 + 反斜杠转正斜杠，`permission-model.ts:84`），否则改了文件要重启才生效——这会直接违反判据 ③（生效时机必须说清且为真）。
- **安全红线（沿用既有约束）**：`allow` 规则不得覆盖 `never_auto_approve` 与受保护路径，写入时即拒绝（`permission-model.ts:170`），本次不放松。

### 3.3 `/config` POST 补写入门
现在 `/config` 的 POST **没有**跨站/token 校验（`server.ts:1597`），而设置的"模型/交互"两个 tab 都要写它。本次一并加同一道门（403 → 401 → 400）。
已核实调用方只有 Web UI 自身（`SystemPanel.svelte:473/487`），应用 iframe 与 app-bridge 不调用它（`app-bridge.ts` 只走 `/apps/:id/bridge`），所以收口不会打断应用。

### 3.4 顺带修正
- `src/server.ts:2349` 的提示文案改为**实际存在**的路径（新 IA 下的 设置→模型→模型能力）。
- `allowed_dirs`：**不暴露**（G6），并在 `plans/roadmap-next.md` 标注"待接线或删除"，避免下次又把它当成可用旋钮。

## 四、前端改动（拆分策略：只搬不改）

原则：**能抽组件就抽组件，绝不重写**。`SystemPanel.svelte` 有 1381 行、12 个 tab 分支，重写它是最贵的风险。

- 新增 `SettingsPanel.svelte`：设置外壳（5 tab 左导航 + 单滚动容器）。
- 新增 `SecuritySettings.svelte`：权限规则（内嵌 `PermissionsPanel`）+ 受保护路径 + 永不自动批准 + 命令黑名单/stripSecretEnv + 模式只读。
- 新增 `WorkspaceSettings.svelte`：工作目录（`/dirs` 选择器）+ 三个沙箱根。
- **抽出** `ModelConfig.svelte`（原 `config` tab 的模型段）与 `DeviceStatusCard.svelte`（ASR/TTS/媒体服务器/模型能力，带 `readonly` 开关，**同一实现两处挂载**——避免"同一件事两套实现"这个已经踩过两次的坑）。
- `PermissionsPanel.svelte`：由"右栏 tab"改造为"设置里的 section"——**去掉自身的 `height:100%` + `overflow-y:auto`**，交给设置面板统一滚动（否则又是双层滚动，见上一轮用户反馈）。
- `App.svelte`：右栏 2 tab；新增 `settingsOpen` / `consoleOpen` 两个模态入口；`apps.svelte.ts` 增加 `settingsTab` store 供 StatusBar 徽章深链。

## 五、任务拆分与验收

| 步骤 | 内容 | 验收 |
|---|---|---|
| **P0.1** | 后端：`/sandbox` 新端点 + `/permissions` 扩展与两个 setter + `/config` 补门 | 单测：门（403/401/400 三态）、原子写往返、非法参数拒绝、**生效性**（改 `skip` 后再走一次 `checkCommand` 用新值；受保护路径新增后 `fs_read` 立即被拒） |
| **P0.2** | 前端：设置外壳 + 安全 tab + 工作区 tab + 右栏 2 tab 化 | 构建产物文案核对（新文案在、`rightTab "permissions"` 无残留）；svelte-check 0 错；人工点击清单 |
| **P0.3** | 前端：模型 tab（抽出 ModelConfig + DeviceStatusCard）+ 交互 + 关于；控制台导航分组 + 设备只读化 | 12 个 tab 逐个可打开、内容与改造前一致（`git diff` 核对渲染分支未改） |
| **P1** | StatusBar 权限徽章深链；文案修正；README / CHANGELOG / roadmap | 文案一致；文档与实现一致 |

**每个 tab 的验收句式**（进设置页必须能回答）：进去看到什么 → 改什么 → 写到哪里 → 何时生效 → 失败怎么表现。

## 六、风险与对策

| 风险 | 对策 |
|---|---|
| 拆 `SystemPanel` 引入回归 | **只移动不重写**：`config` 段与模型能力卡整段抽出，其余 11 个分支零改动；用 `git diff` 逐段核对 |
| 双层滚动 / 高度塌陷复发（上一轮踩过） | 设置面板沿用既定规则：**外层单滚动容器 + 子组件不自带 `overflow` + 列内非滚动行 `flex: 0 0 auto`** |
| 改 `protected_paths` 静默丢掉内置基线 | `bootstrap.ts:221` 是 `?? DEFAULT`（**整体替换**，非合并）：UI 必须用**生效清单**回填草稿，移除内置项时二次确认，后端返回 `warning` 列出被移除的基线项（详见 §八 待裁定 1） |
| 应用 iframe 需要 `/config` | 已核实无调用方；若将来需要，走 app-bridge 而不是放宽写入门 |
| 删除右栏权限 tab 导致"找不到" | StatusBar 徽章 + 确认弹窗提示 + 设置页内搜索路径写进 README |

## 七、明确不做

1. **不加权限模式的运行时切换**（auto/ask/plan）：当前无端点，且模式属于"启动时决策"（`--mode` / `default_mode`），本次只做只读展示 + 说明；要切换另立一步。
2. **不给 `allowed_dirs` 做 UI**（G6：零调用方的死配置）。
3. **不合并"应用"与"应用预览"**（运行中应用窗口 ≠ 文件产物，既有裁定不变）。
4. **不重写 `SystemPanel`**（只搬不动）。

## 八、待裁定（2026-09-12 用户已裁定）

1. **`protected_paths` 的语义** → **A**：保留"文件整体替换"语义，但 UI 用**生效清单**回填草稿、移除内置项需二次确认、后端返回列出被移除基线项的 `warning`（保留用户对本人机器的处置权，同时杜绝静默丢保护）。
2. **语音设备（ASR/TTS/媒体服务器）** → **A**：放**控制台→系统**（属观测：看状态 + 下模型）；设置→模型只保留模型能力卡。
3. **`/config` 写入门** → **A**：本次一并加（跨站 403 → 缺 token 401 → 参数 400），结束"结构改造顺带留一个无门写面"的状态。

## 九、实施结果（2026-09-12，未提交）

**已落地**（与 §二 映射表逐条对齐，13 个 tab 零丢失）：

| 交付 | 文件 |
|---|---|
| 设置外壳（5 tab，单滚动容器） | `web/src/components/SettingsPanel.svelte`（新增） |
| 模型（参数 + 能力卡 + 实测按钮） | `web/src/components/settings/ModelSettings.svelte`（新增） |
| 安全（规则 + 受保护路径 + 永不自动批准 + 沙箱强制项 + 模式只读） | `web/src/components/settings/SecuritySettings.svelte`（新增） |
| 工作区（工作目录 + 三个沙箱根 + 目录选择器） | `web/src/components/settings/WorkspaceSettings.svelte`（新增） |
| 交互（思考展示 / 技能沉淀 / 主题） | `web/src/components/settings/InteractionSettings.svelte`（新增） |
| 关于（版本 / 数据目录 / 存储 / 运行时） | `web/src/components/settings/AboutSettings.svelte`（新增） |
| 入口与深链（设置 / 控制台 / tab） | `web/src/lib/stores/shell.svelte.ts`（新增）、`App.svelte`、`Sidebar.svelte`、`TopBar.svelte` |
| `/config` 与 `/sandbox` 的唯一实现 | `web/src/lib/stores/settings.svelte.ts`（新增） |
| 权限面板改为 section（去双层滚动） | `PermissionsPanel.svelte`；嵌入 `SecuritySettings` |
| 右栏 2 Tab + 状态栏权限徽章 | `App.svelte`、`apps.svelte.ts`、`StatusBar.svelte` |
| 控制台分组 + 迁出配置 + 设备只读化 | `SystemPanel.svelte`（**只搬不改**：删 `config` 分支、模型卡改只读快照、左导航分组） |
| 后端写面 | `src/server.ts`（`/sandbox` 新增、`/permissions` 扩展、`/config` 补门、文案修正）、`src/security/sandbox.ts`（`saveSandboxPolicy` / `describeSandboxPolicy` / `resolveSandboxWritePath`）、`src/security/permission-memory.ts`（`setSafetyList` / `readStringList` / `writeConfigData`）、`src/security/permission-model.ts`（两个 setter）、`src/security/json-file.ts`（新增）、`src/server-deps.ts` |

**与方案的偏差（1 处）**：设置→模型的能力卡与"下发实测按钮"没有做成"控制台只读 / 设置可写"的**两套组件**，而是**控制台只留只读快照 + 一句指引**（"要修改模型或重新实测能力：设置 → 模型"）。理由：写入口只能有一个，否则又是"同一件事两处改"。

**验证证据**：
- `npm run verify` exit 0：`tsc` + `eslint` + **1036 例 / 68 文件** + `vite build` + `svelte-check` 0 错 58 警告
- 新增 `test/settings-api.test.ts`（10 例）覆盖：沙箱写路径跟随 `--dir`、未知键/相对路径/空条目/多行命令四类校验、BOM 与未知键保留、`effective` 回退语义、安全清单的 `acknowledge` 确认（未确认时**文件与内存都不动**）、确认后**立即生效**（模型判定随之改变）、`/sandbox` 与 `/permissions` 的三道门、`/config` 收口（403/401/400/200）
- 构建产物文案核对：14 项新文案在、3 项旧文案（「配置不可用（需 --server 模式）」「系统设置」「系统配置（等价 TUI…」）**已消失**

**未由我验证的部分**：浏览器内的实际点击（设置/控制台两侧导航、目录选择器、确认勾选、状态栏徽章跳转）需人工确认——本轮已用"构建产物文案 + 端到端端点测试 + `svelte-check`"做静态兜底，但面板挂载交互仍在人工核对范围内。
