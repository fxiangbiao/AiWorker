# Sprint 38 — 文档预览支持工作目录文档（0.9.2）

> 状态：**✅ 开发完成（556 测试全绿，待提交）**
> 需求：文档预览面板除了 `data/docs/` 会话资产，也能查看工作目录（输出目录）中 agent 产出的 .md 文档
> 现状：生成型文档落 `data/docs/<sessionId>/`；对话中 agent 用 fs_write 写到 workingDir 的 .md（方案/报告/README 等）不在预览范围
> 前置：0.9.1（9cd477a）

## 一、目标

1. 文档预览两个来源：**会话资产**（data/docs/，现状）+ **项目文档**（workingDir，新增）
2. 安全不降级：每个 root 独立 resolve + 相对路径校验（沿用现有穿越防护）
3. 性能可控：workingDir 可能巨大（node_modules 等），需排除规则 + 上限
4. UX：分组展示 + 来源标识；新写的文档能及时出现

## 二、设计

### 1. 后端 API（src/server.ts，复用现有 /docs 路由）

```
GET /api/v1/docs → { roots: [{root, dir}], docs: [{root, path, title, size, mtime}] }
```
- root ∈ `"session" | "project"`；`path` 为 root 内相对路径；`title` 去 .md 的文件名
- `roots` 返回两个来源的绝对目录（前端可显示「项目文档 · <dir 名>」）
- 兼容：旧响应只有 docs 数组，前端加 root 字段解析（无 root 视为 session）

```
GET /api/v1/docs/content?root=session|project&path=rel
```
- session → `resolve(dataDir/docs, rel)`（现状）
- project → `resolve(workingDir, rel)`；同样 `relative()` 校验（不以 `..` 开头、非绝对、isFile）

**project 扫描规则（防噪音/防性能问题）**：
- 排除目录（按名）：`node_modules .git dist build .venv venv __pycache__ .next coverage out`
- 排除应用自身 dataDir（若嵌套在 workingDir 内，按绝对路径排除，避免把 `data/docs` 重复扫进来）
- 深度 ≤ 4 层；.md 数量上限 200（超出按 mtime 最新截断）；单文件 ≤ 1MB
- 按 mtime 降序返回（AI 刚写的文档排最前）

### 2. 前端（docViewer 需 root 感知）

- `docViewer` 值改为 `session:<rel>` / `project:<rel>` 前缀 key（无前缀兼容视为 session）
- `DocPreviewPanel`：chips 分两小节「会话资产」「项目文档」（project 无文档时整节隐藏）；
  project 文档 title 用相对路径（如 `docs/design.md`，比文件名更有辨识度），session 保持现状文件名；
  加手动刷新按钮；面板打开/切换文档时自动刷新（现状逻辑保留）
- `DocRenderer`：解析 root 前缀传给 `/docs/content`；**仅 session root 加载图表 sidecar**（`data.json`）——项目里同名 JSON 会被误读为图表，project root 跳过
- 新文档出现时机：监听现有 `session/update`（每轮消息后服务端广播）触发列表刷新，无需新增事件

### 3. 不改动

- fs_write / agent-loop / 文档生成链路（只读浏览，不做编辑）
- data/docs 会话资产生成逻辑
- 图表渲染、TOC、滚动跟随逻辑

## 三、测试

- `/docs` 返回 project 文档（fixture workingDir 下写 .md + node_modules 内 .md 被排除）
- `/docs/content?root=project` 正常读取；`../` 穿越拒绝 404；root=session 兼容旧行为
- 前端验证链：build/lint/test/web:build

## 四、风险

- 项目内 .md 可能含非 AI 生成的历史文件（噪音）：mtime 降序 + 分组隔离，可接受；后续可加「仅最近修改」开关
- 扫描性能：排除规则 + 深度/数量/大小上限兜底
- 相对路径 title 可能较长：chips 已有 max-width 截断

## 五、版本

0.9.2：package.json → CHANGELOG.md → README 徽章（提交时同步）
