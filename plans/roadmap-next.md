# AiWorker 后续发展路线图（2026-09 起）

> 依据：`docs/主流Agent产品对比分析报告.md`（2026-09-10）
> 基线：AiWorker 1.9.1 / 测试 1153 例全绿（1.4.0 起的逐期演进见 `sprint-history.md`）
> 原则：**先补可信底线，再补能力纵深，最后才是场景与生态扩张**；始终守住「本地优先、离线可用、中文优先、单体可读」的定位，不与 Claude Code 争编码主战场、不与国产办公品牌争生态。

---

## 一、总览

| 阶段 | 主题 | Sprint | 目标 |
|---|---|---|---|
| P0 | **可信基线** | S47 ✅ / S48 ✅ | 让 AiWorker 从"能用的个人玩具"变成"可被信任与编排的工具" |
| P1 | **长程与工具纵深** | S49 ✅ / S50 ✅ / S51 ✅ / S52 ✅ | 从"一次一问"到"可持续推进的任务"；补齐工具面与回滚能力 |
| P2 | **场景扩张与生态** | S53+ | 交付物（Office 写出）、多端、插件市场、观测与团队特性 |

每一项都对应报告中的具体差距编号（见报告第四章）。

---

## 二、P0 — 可信基线（Sprint 47–48）

| # | 事项 | 报告差距 | 状态 |
|---|---|---|---|
| P0-1 | CI 门禁：build / lint / test / web:build（GitHub Actions） | 4.2-#6 无 CI | ✅ S47 |
| P0-2 | Web 静态检查：svelte-check 纳入门禁并清零既有错误 | 4.2-#7 前端无静态检查 | ✅ S47 |
| P0-3 | 权限规则化：`Tool(specifier)` 级 deny→ask→allow、通配、永不自动批准清单、受保护路径 | 4.1-#2 权限粒度粗 | ✅ S47 |
| P0-4 | Windows 最小沙箱：terminal_exec 可写根约束 + cwd/env 约束（非内核级，诚实标注） | 4.1-#1 无进程沙箱 | ✅ S47 |
| P0-5 | headless 模式：`aiworker -p "<prompt>" --output-format json\|stream-json`（可被 CI/脚本编排） | 4.2-#4 无 headless/SDK | ✅ S48 |
| P0-6 | 检查点与回滚：每轮快照 + `/rewind`（代码+对话 / 只对话 / 只代码） | 4.3-#12 无检查点 | ✅ S48 |
| P0-7 | 测试确定性：消除依赖 mtime/readdir 顺序的既有 flaky 用例 | 工程质量 | ✅ S47（hooks 两例） |

**验收标准（P0 全体）**：`npm run verify` 一条命令全绿；CI 在 push/PR 上红灯即阻断；任何工具调用都能回答"谁允许的、按哪条规则、是否可撤销"。

---

## 三、P1 — 长程与工具纵深（Sprint 49–52）

| # | 事项 | 报告差距 | 关键设计取舍 |
|---|---|---|---|
| P1-1 | **后台子智能体**：`spawn` + `send_message` / `interrupt_agent` / `list_agents`（fork 拆至 S53） | 4.3-#9 并行长程弱 | 先做"可续接的子会话"（复用 `session_events` + `wk-` 隔离），不做进程池；**前置：P1-4 权限记忆**（子智能体无确认通道，只能靠预先授予的规则） | ✅ S52 |
| P1-2 | **目标驱动（goal）**：持久目标 + 轮次驱动 + 事件溯源 | 4.3-#9 | 复用事件日志与 TurnLog，不引入新存储 | → S53 |
| P1-3 | 工具面扩展：LSP（本地 TS/Python）、浏览器自动化、Notebook 编辑、图像理解 | 4.3-#10 工具面窄 | 每项独立可关；能力声明进入工具白名单体系 | 待定 |
| P1-4 | 权限记忆：allow-always（会话级/项目级）+ 一键撤销 + `/permissions` 可视化 | 4.1-#3 审批无记忆 | 规则持久化到 `config/permissions.json`（复用 S47 schema） | ✅ S49 |
| P1-5 | 压缩与成本：压缩阈值可调 + 工具结果剪枝 + 本地成本估算（仅展示） | 4.3-#14 策略单一 | 不做计费，只做"看得见" | → S54 |
| P1-6 | 会话体验：搜索/分组/归档、跨会话引用、突破 50 条上限 | 4.4-#15 | 纯前端 + `/sessions?limit` 已有基础 | → S55 |
| P1-7 | 沙箱增强：fs 工具的写根与受保护路径统一走策略层（当前仅命令层） | 4.1-#1 | 与 S47 的 `allowWriteDirs` 对齐 | ✅ S49 |

---

## 四、P2 — 场景扩张与生态（Sprint 53+）

| # | 事项 | 报告差距 | 说明 |
|---|---|---|---|
| P2-1 | **Office 交付**：docx / xlsx / pptx 写出 + 图表生成 | 4.3-#11 交付物弱 | 办公场景的入场券；可先做"模板填充 + 表格/图表" |
| P2-2 | 多端：移动端（看进度、批准危险操作）+ 桌面壳（Tauri 复用 Web UI） | 4.2-#8 无多端 | 云端/长任务不在路线内 |
| P2-3 | 插件市场：插件契约升级（版本/依赖/能力声明）+ 官方目录 + 安装命令 | 4.2-#5 无生态 | 沿用 `config/plugins` 契约演进 |
| P2-4 | 观测与合规：OTel/指标导出、审计导出（CSV/JSON） | 4.4-#16 | 面向自证与复盘 |
| P2-5 | i18n：英文界面与文档 | 4.4-#16 | 复用中文优先结构 |
| P2-6 | 团队共享：可选加密同步的共享记忆/技能 | 4.3-#10 | 保持本地优先，同步为可选项 |

---

## 五、明确不做（防守边界）

1. **不做通用编码 IDE**：不与 Claude Code / Codex 的 20 并发 + 1M 上下文 + 官方市场正面竞争。
2. **不自建云沙箱、不训练模型**：与"本地优先、数据不出本机"定位冲突；需要云端时接第三方或用户自建端点。
3. **不追企业办公生态**：钉钉/飞书级权限继承与 100+ 伙伴生态不是个人项目的战场；办公方向只做"本地文件就地处理 + 交付物写出"。
4. **不为并发而并发**：先把单链可靠性与可恢复性做扎实（检查点、审计、失败续跑），再谈并发上限。

---

## 五之二、安全债（2026-09-20 审核登记，**未修**）

1.9.1 的代码审核（安全轮）枚举了全部 34 个写端点，**22 个没有写面门禁**（跨站 403 / token 401），而服务端对任意来源开放 CORS（`Access-Control-Allow-Origin: *` + OPTIONS 放行 `Content-Type`/`X-AiWorker-Token`），因此这些端点可被跨站页面直接调用。按严重度登记如下，**均需在后续 sprint 立项修复**：

| 级别 | 问题 | 关键位置 |
|---|---|---|
| **高** | `POST /confirm`、`/ask` 无门禁；`/api/v1/ws` 升级不校验 Origin/token 且 `eventBus` 全量广播 `confirm_request`（含 `confirmId` 与选项）→ 恶意页面可**替你批准高危操作并写入项目级规则**；配合同样无门禁的 `POST /chat` 形成"访问网页 → 主机命令执行"；`confirmId` 为 `cf-<ts36>` 可枚举；`GET /` 免鉴权下发 `window.__AIWORKER_TOKEN__` 且 `listen(port)` 未绑 host（LAN 对端可拿 token） | `src/server.ts` 的 `/confirm`、`/ask`、`/chat`、WS upgrade、`listen` |
| 中 | 读面无鉴权：`GET /subagents`、`/jobs`、`/schedule` 跨站可读，泄露子智能体任务原文/摘要与定时任务内容 | `src/server.ts` 三处 GET |
| 中 | `config/schedule.json` 运行期数据未 gitignore，`git add -A` 会把它变成"仓库级定时执行"（含用户真实任务） | 仓库根 `.gitignore` |
| 低 | 直接代码执行面未收口：`POST /packages/import`（安装即执行插件代码）、`/apps/*`（生成/安装/启动/能力桥） | `src/server.ts` |
| 低 | HTTP 子智能体端点无会话归属校验（工具层有）；`never_auto_approve` 仅含 `spawn_agent`/`send_message`（`interrupt_agent`/`list_agents` 在 auto 模式免确认） | `src/server.ts`、`config/permissions.json` |

修复口径（建议）：写/读端点统一走 `isCrossSiteRequest` 403 + `X-AiWorker-Token` 401；WS upgrade 校验 token 或至少 Origin，并收敛广播范围；`listen` 绑定 `127.0.0.1`，`GET /` 不再免鉴权下发 token。

---

## 六、里程碑判据（每个 Sprint 收尾必查）

1. `npm run verify` 全绿（build / lint / test / web:build / svelte-check），CI 同步变绿；
2. 新能力有测试（端点或单测），关键安全路径有反例用例；
3. `CHANGELOG.md` 记录变更与取舍，`plans/sprint-NN-*.md` 保留设计意图；
4. 不破坏既有交互（TUI 与 Web 双界面行为一致，除非明确声明差异）。
