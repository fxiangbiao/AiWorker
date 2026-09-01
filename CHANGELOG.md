# Changelog

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
