# Sprint 42 — AI OS 1.0 整合 + 每会话项目目录（1.0.0）

> 状态：📋 计划待确认
> 需求：① 设计文档 Sprint 38（1.0.0 里程碑）——控制台统一（审计/设备视图）、资源仪表、示例应用包、正式文档；② 用户新增：**每个会话可选择自己的工作目录**（当前固定 `--dir` 默认 ai_default_project）
> 现状：0.12.0 进化引擎三期闭环已齐；Web 控制台 11 Tab 缺「审计」「设备」；工作目录全局单一
> 前置：0.12.0（Sprint 41 验收后提交）

## 一、目标

1. **每会话项目目录**（工作流 B，先做——跨切面基础）：会话可选择自己的 workingDir，fs 工具/沙箱/文档面板跟随，全局回退
2. **审计 Tab**（A1）：全量操作审计可查（应用生命周期/权限/进化/崩溃），补通用查询 API + Web 视图
3. **设备 Tab**（A2）：media 三通道状态 + 模型多模态能力展示
4. **进程资源仪表**（A3）：进程视图补 token/耗时资源条 + 顶栏预算占用
5. **示例应用包**（A4）：`.aw` 打包 3 个示例，验证 /pkg → /install 全链路
6. **正式文档**（A5）：`docs/ai-os-architecture.md` + README 更新 → 版本 **1.0.0**

## 二、设计

### 工作流 B：每会话项目目录

**关键发现（已核实）**：`Task.workingDir?`（types.ts:203）+ base-agent 已 `task.workingDir ?? workingDir`（base-agent.ts:139/221）→ **agent 层零改动**，只需把会话目录灌进 task 并持久化。

1. **存储**：`SessionRecord` 加 `workingDir?: string`；`sessions` 表加列 `working_dir TEXT`（ensureSession INSERT 含列；旧行 null = 回退全局）；session-store 加 `getWorkingDir(id)` / `setWorkingDir(id, dir)`（UPDATE）
2. **/chat 透传**：server /chat 构造 task 时，sessionId 存在 → `task.workingDir = sessionStore.getWorkingDir(sessionId) ?? undefined`（base-agent 自动优先；agent-loop → ToolContext/Sandbox 根/approval projectBase 全链路跟随——既有机制验证即可）
3. **API**：
   ```
   GET  /api/v1/sessions/:id/working-dir   → { workingDir: string | null }
   POST /api/v1/sessions/:id/working-dir   → { ok, workingDir }   body { dir }
   ```
   - 校验：非空、**绝对路径**、`existsSync` + `isDirectory`；拒绝指向 dataDir 自身（防套娃）；其余用户显式选择即授权
   - 写库 + 审计 `session:working-dir`（target=sessionId, detail=dir）+ 广播 `session/update`
4. **CLI `/dir`**：`/dir`（查看当前会话目录）/ `/dir <绝对路径>`（设置当前会话）；无 currentSessionId 提示先选会话；并入 commands/session.ts
5. **文档面板**：`/docs` 加 `?sessionId=` → project root = 会话目录 ?? 全局（server.ts:1538 与 1615 两处 project 分支）
6. **Web UI（会话控制条 + 侧栏标记）**：
   - **入口**：InputArea 下方「会话控制条」加「项目目录」徽标——展示**生效目录**（会话目录 ?? 全局默认）并标注来源：自定义显示目录名+「自定义」标记，未设置显示「默认目录」；tooltip 含完整路径与来源 → 点击展开**目录编辑器**（绝对路径输入框 + 「保存」+「恢复默认」清空）；校验失败（不存在/非目录/指向 dataDir）→ 输入框内联红字提示，不落库
   - **StatusBar 移除 💻 工作目录项**（已确认：目录会话化后全局默认仅回退值，放全局状态条误导；StatusBar 回归 model/tokens/cost/进程纯系统状态）
   - **保存流程**：`POST /sessions/:id/working-dir` → 成功刷新徽标 + 广播 `session/update` → DocPreviewPanel 项目文档根自动重载（带 sessionId 重新拉 `/docs?sessionId=`）
   - **会话列表联动**：Sidebar 会话行对有自定义目录的会话显示 📁 标记（tooltip 目录名）；`GET /sessions` 列表响应补 `workingDir` 字段（后端一处 + 前端一处）
   - WS `session/update` 联动：其他端改了当前会话目录，徽标与文档面板自动刷新
7. **边界（明确不做）**：job-runner/团队协作/语音走全局目录（detail 注明"全局"，后续可会话化）；不做目录浏览器（输入框 + 校验提示即可）；不做跨会话继承

### A1：审计 Tab

1. `src/security/audit-log.ts` 加 `queryRecent(limit = 100, actionPrefix?)`（`ORDER BY timestamp DESC LIMIT ?`，可选 `action LIKE prefix%`）；auditLogger 透出
2. API `GET /api/v1/audit?limit=50&action=evolution:%2A` → `{ entries: AuditEntry[] }`
3. Web SystemPanel 加「审计」Tab：时间/动作/目标/结果/详情/会话 表格，success/blocked/error 着色，action 前缀 chips（全部/app:*/evolution:*/tool:*/session:*）+ 手动刷新

### A2：设备 Tab

1. `src/media/status.ts`（新增）：汇总三通道——ASR（模型下载状态：无/下载中/就绪）、TTS（edge-tts 可用 / sherpa 本地降级）、media-server（进程状态）；从既有模块只读探测（不启动不修改）
2. API `GET /api/v1/devices` → `{ asr, tts, mediaServer, model: { current, multimodal: { vision, audio } } }`（model 从 modelRouter.getAvailableModels/当前模型能力标记）
3. Web「设备」Tab：通道状态卡（✅/⏳/⚠️）+ 模型能力表（多模态标记）
4. 只读展示，不做真实设备控制（范围控制）

### A3：进程资源仪表

1. ProcessPanel 增强：进程行补 token 占用（jobRunner 已有 token 字段则展示；Agent 进程用 modelRouter 全局 token 近似标注）+ 状态/耗时着色已有保留
2. 顶栏预算占用条（可选）：StatusBar 加 token 占用条（`GET /status` 已有 tokensUsed —— 查现状，简单则做）

### A4：示例应用包

1. `examples/` 下 3 个示例源：番茄钟（webapp 多文件）、批量重命名（tool 脚本应用）、文本统计服务（service）——手写高质量示例（含 manifest/权限声明）
2. `/pkg examples/<name>` → `dist-examples/<name>.aw`；`/install` 验证安装 → 运行 → 销毁全链路
3. 单测：打包产物结构（zip+manifest 校验）+ 安装/启动/销毁 mock 链路

### A5：正式文档 + 版本

1. `docs/ai-os-architecture.md`：从 `AIOS-架构升级方案.md` 提炼正式版——愿景/分层架构图（大脑-手脚-进程-设备）/安全模型/进化闭环（观察→提议→确认→生效→回滚→评测→验证）/快速开始/CLI 速查
2. README 更新：功能矩阵补 1.0 能力 + 架构简述
3. 版本 **1.0.0**（package.json/CHANGELOG/README 徽章）

## 三、测试

- **B**：session-store 列读写（含旧行 null 回退）、/chat task.workingDir 透传（mock sessionStore）、端点（校验非法路径/不存在目录/指向 dataDir 拒绝、持久化、审计、GET 回读）、CLI /dir 查看与设置、docs ?sessionId 项目根跟随、无会话目录回退全局、`GET /sessions` 列表带 workingDir、**StatusBar 移除 💻 项后 web tsc 无残留引用**；Web 校验交互与侧栏标记由实机验证覆盖
- **A1**：queryRecent（limit/action 前缀过滤/降序）、端点、auditLogger 透出
- **A2**：status 汇总（三通道状态 + 模型能力）、端点
- **A4**：打包产物结构 + 安装/启动/销毁链路
- 全量验证链：`npm run build && npm run lint && npm test && npm run web:build` + web tsc 0 错误

## 四、风险

- 会话目录影响面广（工具/沙箱/审批/文档）→ 靠既有 `task.workingDir` 管道单点注入，改动集中 server /chat + store；job/协作明确保持全局，防隐式漂移
- 用户可能把目录指到任意位置 → 绝对路径 + 存在性校验 + 审计留痕；fs 沙箱根自动跟随是既有安全机制（用户选择即授权，与 `--dir` 同权）
- 审计表增长 → 查询带 LIMIT + action 过滤；不做清理/导出（范围控制）
- media 状态探测依赖模块内部状态 → 只读探测失败降级显示"未知"，不阻塞
- 示例包手写可能引入环境依赖 → 仅内置模块 + webapp 纯前端，严格按能力桥白名单
- 本期体量大（6 工作流）→ 开发顺序 B→A1→A2→A3→A4→A5，每步独立可验；如中途要拆，B+A1 可独立成 0.13.0

## 五、版本

1.0.0：package.json → CHANGELOG.md → README 徽章（提交时同步）
