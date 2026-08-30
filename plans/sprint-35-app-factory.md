# Sprint 35 — AI OS 应用工厂 v2 + 窗口体系（0.8.0）

> 状态：**✅ 已完成（0.8.0，已提交）**
> 需求：一句话生成应用（留存/销毁闭环）+ 可拖拽窗口呈现 + 生成过程实时可视化
> 设计依据：`docs/AIOS-架构升级方案.md` §4.3/4.4 + 实机反馈
> 合并说明：本文件合并原 `sprint-35-app-factory.md` 与 `sprint-35-app-window-fix.md`，并采用 v2 生成方案

---

## 一、背景与方案修订（v1 → v2）

**v1 缺陷（实机暴露）**：生成采用"LLM 直出文件 + 分块续写拼接"，触发单次输出上限 → 截断、拼接语法错误、修复重试不稳定（如复杂电子宠物反复失败）。

**v2 核心决策**：**复用 agent-loop + fs_write 工具生成应用**——LLM 通过工具调用把代码写入文件，与智能体对话中写文件**无区别**。这是 AiWorker 已成熟稳定的路径（多轮迭代/上下文/流式/轨迹/超时预算），长代码由**多轮工具调用**自然解决，彻底删除续写/拼接逻辑。

**框架/模型职责分离（已确立）**：
| 归属 | 内容 |
|------|------|
| 框架（宿主） | 窗口 chrome（拖拽/缩放/全屏/置顶/最小化/关闭）、小部件透明背景、`index.html` 骨架、全局 reset 样式、能力桥注入、manifest 生成（id/permissions 可控） |
| 模型（创造性） | `app.js`（应用 UI/交互/逻辑/内联样式）、`style.css`（可选）、tool 的 `index.mjs`、doc 的 `report.md`+`data.json`——**无行数限制，写多长都行** |

## 二、已实现（v1 交付，本计划确认收尾）

- **窗口体系**：三形态（panel/float/widget）+ 拖拽（setPointerCapture）/缩放/全屏（panel↔float）/置顶/最小化/关闭 + 位置持久化 + iframe 沙箱（无 allow-same-origin）+ 懒挂载 + **widget 透明悬浮**（hover 迷你工具条）
- **能力桥**：宿主注入（C 方案）`window.__AIWORKER_BRIDGE__`（storage/notify/llm/fs/http，无 terminal）+ `/apps/:id/bridge` 端点
- **异步生成队列**：`generator-queue`（jobId 即返、状态流转、取消排队任务、gen/* 事件）
- **进度可视化**：GenWizard 进度条 + 轨迹时间线（detail）+ 生成中可关闭（后台继续）
- **文档工作台**：目录/Markdown 渲染/导出/**图表**（data.json bar/line）
- 窗口交互修复、iframe 首帧填充修复、`ui.surface` 透传

## 三、重构核心：AppFactory 用 agent-loop 生成（P0）

```
/app new <描述> → queue 入队
  │
  ▼ factory.generate(spec)
  1. genId + mkdir data/apps/_gen/<genId>/
  2. 构造「生成 agent」配置（临时，非 7 专家之一）：
     - systemPrompt = 模板提示词（应用描述/目录约定/能力桥/fs_write 用法/完成条件/自查清单）
     - tools = [fs_write, fs_list, fs_read]（沙箱 _gen 内）
     - maxIterations = 30；modelPreference = "coding"
  3. runAgentLoop(config, 任务消息, deps: { workingDir: _gen 目录, ... })
     - onToolCall/onToolResult → gen/progress 轨迹（"正在写入 app.js…" / "app.js 写入完成（N 行）"）
  4. 校验器（最终把关）：app.js 语法 + 引用完整性 + 单文件存在
     - 不过关 → 追加消息反馈 LLM 自查再修（≤2 轮）
  5. 工厂生成 app.json + index.html（宿主骨架）→ 安装 → 启动
```

**完成判定**：LLM 工具写完文件后，最后一条消息声明"完成"（agent-loop 自然终止）；迭代上限兜底。校验器仍做最终把关。

**删除（v1 弯路）**：`LlmAppGenerator`、`AppGenerator` 接口、分块续写、`continueFilePrompt`、`MAX_CHUNKS`、`parseGenFiles`、语法修复循环——全部废弃。

**模板适配（简化）**：
- **webapp**：宿主给 index.html + app.json；LLM 用 fs_write 写 app.js（+可选 style.css）
- **tool/service**：LLM 写 app.json（含 tools 声明，工厂覆盖 id/permissions）+ index.mjs
- **doc**：LLM 写 report.md + data.json
- skill/agent：LLM 写 SKILL.md / agent.yaml（保留）

## 四、范围

| 优先级 | 内容 |
|--------|------|
| **P0** | agent-loop 生成管线重构（删续写/拼接）+ 模板适配（webapp/tool/doc）+ 完成判定/校验反馈循环 |
| **P0** | 进度/轨迹改用 agent-loop 工具事件（onToolCall/onToolResult → gen/progress） |
| **P1** | 窗口体系收尾验证（widget 透明/拖拽/全屏） |
| **P1** | 文档工作台 + 图表（已实现，回归） |
| **P2** | running 任务可取消（AbortSignal，可选） |

**不做**：生成总耗时限制（用户拍板：不限制，防误杀成功生成；依赖 API 层超时）；P2 并行生成/预生成缓存（留后续）。

## 五、涉及文件

- `src/core/app-factory.ts` — 重写：agent-loop 生成（构造生成 agent + runAgentLoop + 校验反馈循环）；删 v1 生成器
- `src/core/app-templates/*.ts` — 提示词改"生成 agent 系统提示"（描述应用/目录约定/fs_write 用法/完成条件）
- `src/core/generator-queue.ts` — 进度回调接 agent-loop 工具事件
- `src/core/app-bridge.ts` / `server.ts` — 保留（宿主骨架/桥接注入）
- `web/src/components/GenWizard.svelte` — 保留（进度/轨迹展示，事件源换 agent-loop）
- 测试：`test/app-factory.test.ts` 重写（mock 模型返回 fs_write 工具调用 → agent-loop 执行 → 校验安装；或 mock 生成 agent 循环）；回归

## 六、测试计划

- `app-factory`：mock LLM（工具调用序列：fs_write app.js → 完成）→ agent-loop 执行 → 校验 → 安装 → 启动全链路；校验失败反馈循环（≤2 轮）；doc/tool 路径
- 回归：515 全绿
- LLM 真实生成：实机验证

## 七、实机验证清单

1. `/app new 电子宠物小狗（摇尾巴/吐舌头/转圈/抱拳/跳舞）` + widget → **多轮 fs_write 写 app.js**（轨迹实时显示每步写入）→ 完成 → **透明悬浮宠物动画**常驻桌面
2. `/app new 番茄钟` → 正常生成运行，窗口拖拽/缩放/全屏/置顶/最小化/关闭
3. `/app new 一份项目周报` → report.md + data.json → 文档工作台渲染 + 图表
4. 生成中可随时关闭弹窗（后台继续，完成自动通知）
5. 截断场景（超长 app.js）→ 多轮工具调用自然完成，无拼接错误

## 八、风险与取舍

| 风险 | 应对 |
|------|------|
| 生成 agent 多轮迭代耗时（长应用多轮 fs_write） | 轨迹实时可见（每步写入），用户感知"在写代码"而非卡死；迭代上限兜底 |
| LLM 写文件后不自查（漏文件/语法错） | 校验器最终把关 + 反馈循环（≤2 轮） |
| 生成 agent 乱写（越出 _gen 目录） | fs_write 沙箱基准 workingDir=_gen，路径穿越防护已有 |
| 生成 agent 需权限确认？ | 生成是自动任务：不注册 ask/confirm（fail-closed 拒高危），fs 工具在沙箱内直接允许 |
