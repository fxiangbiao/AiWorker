# Changelog

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
- **测试确定性**：修复两处 captureDiff 用例依赖共享快照目录 + mtime 排序的潜在竞态（改为每次运行独立 sessionId，断言快照唯一）；新增 `permissions-rules` 14 例、沙箱写入约束 12 例；全量 **862 / 59 文件** 全绿
- **文档**：新增 `plans/roadmap-next.md`（P0/P1/P2 路线图）、`plans/sprint-47-credibility-baseline.md`（设计与验收）；README 补充权限规则 schema、沙箱边界与 `verify` 命令

### 代码审查跟进：沙箱写入约束与受保护路径加固
- **沙箱**：原"取命令位置后第一个非开关 token"被三类常见写法绕过——带值开关顶位（`Set-Content -Encoding utf8 <越界>`、`New-Item -ItemType Directory -Path <越界>`、`Add-Content -Value hi -Path <越界>`）、目标不在首位（`Copy-Item a.txt <越界>`）、别名与未列举程序（`rm -rf`、`ni`/`sc`/`cp`/`mv`/`ri`、`curl -o`、`Invoke-WebRequest -OutFile`、`robocopy`、`xcopy`、`tar -C`、`Expand-Archive`、`git clone`、`npm install --prefix`）。现改为校验片段内**所有**像路径参数并纳入上述别名/程序；引号内文本用等长掩码定位、回取原文取参数
- **重定向引号感知**：非包裹命令中引号内的 `>` 不再视为重定向（`echo "compare > C:\x"` 不再误拒）；解释器包裹（`cmd /c "echo x > …"`）仍按引号不敏感扫描，越界照样拦截
- **受保护路径按路径段匹配**：`.git` 不再误伤 `.gitignore` / `.gitattributes` / `.github/**`（原实现在 auto 模式下会强制确认、无确认通道时直接拒绝）；命令文本先拆候选片段再切段，`git config --file .git/config` 仍命中；默认补 `.envrc`
- **规则加载校验**：`tool` 非空串、`action ∈ deny|ask|allow`、`match` 为字符串或缺省，否则丢弃并告警——避免 `"action": "denyy"` 使 deny 规则**静默失效**
- **`allow` 免确认显式限定 auto 模式**，不再依赖 `permissionCheck` 先于 `confirmHighRisk` 的隐式钩子顺序
- **行为变更**：写入根约束现**先于**危险检测生效，`rm -rf /` 由"确认后可执行"变为"任何模式直接拒绝（写入越界）"；需终端写入项目根之外时请在 `allowWriteDirs` 中声明
- **顺带修复**：`FileDiffPanel.sessionTitle` 读 `DiffSession` 上不存在的 `id`（无 summary 时会 `undefined.slice` 抛错）→ 改 `sessionId`；`asset-url` 的 `/files` 前缀补边界判断；`DocPreviewPanel` 行类型 `collapsed` 改为仅目录行必填；`check:web` 统一走 `web` 的 `check` 脚本

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
