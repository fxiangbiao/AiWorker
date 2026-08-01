# Sprint 13.1: Web UI 设计方案

> AiWorker 浏览器端对话界面 — 零后端依赖，纯静态单页应用

---

## 一、设计目标

| 维度 | 目标 |
|------|------|
| 依赖 | 零 npm 依赖。marked.js 通过 CDN 加载（20KB，仅 Markdown 渲染） |
| 传输 | SSE 流式，复用现有 `POST /chat` 端点 |
| 兼容 | Chrome / Edge / Firefox 最新版，桌面优先 |
| 体积 | 单文件 `web/index.html`，< 500 行 JS |
| 风格 | AI-Native UI（基于 ui-ux-pro-max-skill 设计系统） |

---

## 二、视觉风格

### 设计演进

初始方案为 Tokyo Night 终端美学，经用户反馈"太丑"，调研后选用 **ui-ux-pro-max-skill**（112k stars）设计系统中的 **AI-Native UI** 风格——专为 AI 交互产品设计的视觉语言。

### 设计理念

**AI as streaming manufactory**。不是聊天软件，是持续生成中的智能工坊。流式内容以渐变光晕高亮，工具执行以脉冲动画可视化。深色基底（`#0B0E14`）搭配靛紫（`#6366F1`）主色调，传递"AI 正在思考"的氛围感。

### 配色方案 (AI-Native UI)

```
底色    #0B0E14  ── 深空黑，减少视觉疲劳
面板    #131620  ── 微亮表面
边框    #1E2330  ── 低对比分界
主色    #6366F1  ── 靛紫，AI 感
辅色    #818CF8  ── 流式光晕起点
辅色    #A78BFA  ── 流式光晕终点
文字    #E2E4E9  ── 高可读性浅灰
次要    #6B7280  ── 辅助信息
成功    #34D399  ── 工具执行成功
警告    #FBBF24  ── 警告
错误    #F87171  ── 失败
信息    #60A5FA  ── 工具调用标识
```

### 字体 (Google Fonts CDN)

- UI 字体: **Inter** 400/500/600
- 代码字体: **JetBrains Mono** 400/500

### 特色动效

- 流式光晕 `@keyframes streamGlow`: 边框颜色在靛紫-堇紫间循环
- 工具脉冲 `@keyframes toolPulse`: 执行中蓝色扩散波
- 输入聚焦 `box-shadow`: 紫色外发光 ring
- 消息入场 `@keyframes fadeIn`: 淡入 + 微上移
### 排版

| 层级 | 字体 | 大小 | 用途 |
|------|------|------|------|
| 主字体 | JetBrains Mono | 13px | 所有界面文字、消息 |
| 回退 | Consolas, monospace | — | Windows / Linux fallback |
| 代码 | 继承主字体 | 12px | Markdown 代码块 |
| 标题 | 继承主字体 | 14px bold | 消息角色标签、面板标题 |

等宽字体天然适合代码密集场景，也强化"工具感"。

### 间距与圆角

- 面板内边距: 16px
- 消息间距: 20px
- 圆角: 8px（卡片）/ 6px（按钮/输入）
- 输入框聚焦: 3px 外发光 ring

### 消息布局

AI-Native 风格：**用户消息右侧紫渐边框**，**Agent 消息左侧紫色圆点标记**。不用传统聊天气泡，用色彩编码区分角色。

---

## 三、布局

```
┌──────────────────────────────────────────────────────────────────┐
│  AiWorker  [ask│plan│craft]  [Agent: coding ▼]  [🎧]  ○ online  │  top bar (48px)
├─────────────┬────────────────────────────────────────┬───────────┤
│ 📁 Chats    │                                        │ 📊 Info   │
│  💬 Chat 1  │  ┌──────────────────────────────────┐  │           │
│  💬 Chat 2  │  │ You: 帮我写一个 React 组件       │  │ 文件 diff │
│  💬 Chat 3  │  └──────────────────────────────────┘  │ 技能列表  │
│             │  ┌──────────────────────────────────┐  │ Token统计 │
│ [+ 新对话]  │  │ 🤖 coding                       │  │           │
│             │  │ ▶ 💭 思考 (3步)          [展开]  │  │           │
│             │  │ 我来分析需求并实现...            │  │           │
│             │  │                                  │  │           │
│             │  │ ⚙ terminal_exec "npm init"      │  │           │
│             │  │ ✅ 执行成功 (0.3s)               │  │           │
│             │  │ ⚙ fs_write → src/Button.tsx     │  │           │
│             │  │ 📄 +25 -0                        │  │           │
│             │  │ 组件已创建，包含以下功能:         │  │           │
│             │  │ ```tsx                          │  │           │
│             │  │ const Button = ...               │  │           │
│             │  │ ```                              │  │           │
│             │  └──────────────────────────────────┘  │           │
│             │                                        │           │
│             │  ┌──────────────────────────────────┐  │           │
│             │  │ 输入消息...                  ▶  │  │           │
│             │  └──────────────────────────────────┘  │           │
├─────────────┴────────────────────────────────────────┴───────────┤
│ 🧠 model: deepseek-v4 │ 📊 1.2k/8k tokens │ 💰 ¥0.03 │ 🛠 2 tools │ status bar
└──────────────────────────────────────────────────────────────────┘
```

---

## 四、组件树

```
App
├── TopBar
│   ├── Logo + 标题
│   ├── ModeTabs       (ask / plan / craft)
│   ├── AgentSelector  (下拉选择专家)
│   └── ConnectionDot  (SSE 连接状态)
├── LeftSidebar
│   ├── ChatList       (会话列表，高亮当前)
│   └── NewChatButton
├── MainPanel
│   ├── MessageList    (虚拟滚动 / 自动滚底)
│   │   ├── UserBubble
│   │   ├── AgentBubble
│   │   │   ├── ThinkingBlock  (折叠/展开)
│   │   │   ├── ToolCallCard   (工具名 + 参数 + 耗时)
│   │   │   ├── ToolResultCard (成功/失败 + 摘要)
│   │   │   └── TextContent    (Markdown 渲染)
│   │   └── ErrorBanner
│   └── InputArea
│       ├── TextInput  (多行 textarea, Enter 发送, Shift+Enter 换行)
│       └── SendButton
├── RightSidebar (可折叠)
│   ├── FileDiffPanel  (当前会话文件变更)
│   ├── SkillPanel     (激活的技能列表)
│   └── ContextPanel   (token 分层占比条形图)
└── StatusBar
    ├── ModelLabel
    ├── TokenUsage
    ├── CostCounter
    └── ToolCount
```

---

## 五、SSE 事件流协议

复用现有 `POST /chat`，响应 `text/event-stream`：

```jsonc
// 用户发送
POST /chat
{ "message": "帮我写...", "mode": "craft", "agentId": "coding" }

// SSE 事件
{ "type": "thinking", "content": "▶ 分析需求..." }
{ "type": "thinking", "content": "▶ 确定技术方案..." }
{ "type": "text", "content": "好的" }
{ "type": "text", "content": "，我来" }
{ "type": "tool_call", "name": "terminal_exec", "args": "{...}", "id": "call_1" }
{ "type": "tool_result", "name": "terminal_exec", "success": true, "summary": "..." }
{ "type": "text", "content": "执行成功..." }
{ "type": "done", "tokenUsage": { "total": 1234, "prompt": 500, "completion": 734 } }

// 错误
{ "type": "error", "message": "..." }
```

### 需要新增的 HTTP 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` | 返回 `web/index.html` 静态页面 |
| `GET` | `/sessions` | 列出历史会话 (session list) |
| `GET` | `/sessions/:id/messages` | 恢复会话消息历史 |
| `GET` | `/agents` | 可用智能体列表 (id + name) |

---

## 六、关键交互细节

### 6.1 流式渲染策略

```
text chunk 到达 → 追加到当前 AgentBubble 的 textContent
                  → 实时 Markdown 渲染（debounce 50ms）
                  → 自动滚底（用户未手动上滚时）

thinking chunk → 累积到 ThinkingBlock
                 → 遇 thinking_done 事件折叠并显示步数标签

tool_call → 插入 ToolCallCard（旋转图标 + 工具名 + 参数摘要）
tool_result → 更新前一个 ToolCallCard 状态（✅/❌ + 耗时 + 摘要）

done → 更新 StatusBar tokenUsage
      → 保存消息到 localStorage
```

### 6.2 自动滚底

```
scrollTop 距底部 < 100px → 自动滚底
用户手动上滚 → 暂停自动滚底
新用户消息发送 → 强制滚底
```

### 6.3 思考折叠

```
默认折叠：ThinkingBlock 显示为 "💭 思考中..."
点击展开：显示所有 reasoning_content 步骤
done 后：显示 "💭 思考 (3 步)" 标签
```

### 6.4 工具调用卡片

```
┌─────────────────────────────────┐
│ ⚙ terminal_exec                │  (正在执行时旋转图标)
│   npm init -y                   │  (参数摘要)
│   ✅ 执行成功 · 0.3s            │  (完成后)
└─────────────────────────────────┘

┌─────────────────────────────────┐
│ ⚙ fs_write                     │
│   → src/Button.tsx              │
│   📄 +25 -0                     │  (diff 统计)
│   [查看 diff →]                 │  (点击切换到右侧面板)
└─────────────────────────────────┘
```

### 6.5 右侧面板

- **FileDiffPanel**: 监听 `tool_result` 中文件操作，累积变更清单
- **SkillPanel**: 启动时 `GET /status` 取技能数，持续更新
- **ContextPanel**: 手动触发，仅当前会话有 `/context` 数据时显示

### 6.6 会话持久化

```
localStorage 三级 key：
  aiworker_chats       → [{ id, title, agentId, createdAt }]
  aiworker_msgs_<id>   → [{ role, content, toolCalls, timestamp }]
  aiworker_settings    → { mode, agentId }

启动时读取 → 恢复左侧列表 + 最近 1 个会话消息
/new 点击 → 生成新 id，切换到空白面板
```

---

## 七、Markdown 渲染策略

使用 CDN `marked.js`：

```html
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
```

- 代码块：深色背景 + 等宽字体 + 复制按钮
- 表格：暗色边框
- 链接：外部新窗口打开
- 图片：懒加载
- 自动转义 HTML（防 XSS）

---

## 八、响应式断点

| 宽度 | 布局 |
|------|------|
| ≥ 1024px | 三栏 (sidebar + main + right panel) |
| 768px - 1023px | 双栏 (sidebar + main)，right panel 折叠为 overlay |
| < 768px | 单栏 (main)，sidebar 抽屉 overlay |

---

## 九、实现计划

### T1: HTML 骨架 + CSS
- 三栏响应式布局
- 暗色主题变量
- 消息气泡样式
- 输入区样式

### T2: SSE 客户端 + 消息渲染
- EventSource 连接管理
- 消息类型分发
- 流式追加渲染
- 自动滚底

### T3: 交互组件
- ModeTabs + AgentSelector
- 会话列表 + 切换
- localStorage 持久化
- 输入历史

### T4: Markdown + 工具卡片
- marked.js 集成
- 代码高亮 + 复制
- ToolCallCard + ToolResultCard
- ThinkingBlock 折叠

### T5: 右侧面板 + 状态栏
- FileDiffPanel
- ContextPanel
- StatusBar 实时更新

### T6: 服务端新增端点
- `GET /` 返回 HTML
- `GET /sessions` 会话列表
- `GET /sessions/:id/messages` 消息历史
- `GET /agents` 智能体列表

---

## 十、文件结构

```
web/
└── index.html          (单文件，HTML+CSS+JS, ~550 行)

src/
└── server.ts           (+ GET /, + GET /agents, + ensureSession 修复)
```

---

## 十一、执行记录

| 日期 | 内容 | 提交 |
|------|------|------|
| 2026-08-01 | 初版 Web UI (Tokyo Night 终端风格) | `751985c` |
| 2026-08-01 | 修复 FOREIGN KEY 约束 (ensureSession) | `60f6c40` |
| 2026-08-01 | Web UI v2 — AI-Native 风格重设计 (基于 ui-ux-pro-max-skill) | `1c0c1f2` |

### 最终实现 vs 原计划差异

| 原计划 | 实际 |
|--------|------|
| Tokyo Night 暗色终端 | AI-Native UI (靛紫主色 + 流式光晕) |
| 模拟终端 prompt 输入 | AI-Native 输入框 (聚焦发光 ring) |
| 等宽字体全界面 | Inter (UI) + JetBrains Mono (代码) |
| 无过渡动画 | fadeIn 入场 + 流式光晕 + 工具脉冲 |
| GET /sessions 端点 | 未实现（localStorage 客户端管理） |
