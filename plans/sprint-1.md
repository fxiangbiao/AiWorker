# Sprint 1 — AiWorker Phase 2 启动

> **目标**：补齐 Phase 1 基础设施缺口 + 交付第一个专家智能体（Research）
> **周期**：2–3 天
> **交付物**：可工作的研究分析助手

---

## 任务拆解

### P0 — 基础设施（阻塞所有后续工作）

#### 1. MCP Manager 实现

- `src/mcp/mcp-manager.ts` — MCP 客户端，支持 `stdio` 和 `HTTP` 两种传输协议
- `src/mcp/connection-pool.ts` — 连接池管理，生命周期控制
- 解析 `config/mcp.json`，运行时注册 / 卸载服务器
- 依赖不可用时自动降级（不阻塞启动）
- 参考 MCP 协议规范，工具发现、调用、资源读取三组 API

**验证**：至少能连接一个模拟 MCP 服务器并发现其工具列表

#### 2. 真实 `web_search` API 接入

- `src/tools/builtin.ts:web_search` — 当前仅返回占位字符串
- 接入 HTTP 请求方式，调用搜索 API（Tavily / SerpAPI / Bing Search API）
- 支持参数：`query`、`max_results`、`search_type`（web / news / images）
- API key 通过环境变量或 `config/models.json` 同级配置注入

**验证**：`npm test` 通过，搜索返回真实结果而非占位字符串

#### 3. Memory 边界文件初始化

- `src/memory/compressor.ts` — 会话结束时写入 `data/memory/MEMORY.md`（有界 ≈2200 字符，强制优先级管理）
- `data/memory/USER.md` — 用户画像快照（≈1375 字符），会话启动时注入 context

**验证**：运行后 `data/memory/` 下产生有效文件且大小不超界

#### 4. `onError` Hook 触发补全

- `src/core/agent-loop.ts` — 异常捕获路径增加 `hookManager.trigger("onError", ...)` 调用

**验证**：注册一个 `onError` hook，模拟错误确认被触发

---

### P1 — 第一个专家智能体

#### 5. Research 研究分析智能体

- `src/agents/research-agent.ts` — 继承 `BaseAgent`，使用 `AgentConfig` 注入
- System prompt：资深研究分析师人设，结构化报告输出（摘要 → 详细分析 → 对比矩阵 → 结论 → 参考来源）
- 模型偏好：`reasoning`，最大迭代 80 次
- 安全级别：`ask`（只读为主，写文件需确认）
- 依赖工具：`web_search`、`web_fetch`、`fs_write`

**验证**：用简单研究任务（如"比较 React vs Vue 技术趋势"）跑通完整循环

#### 6. 专家路由器

- `src/agents/router.ts` — 两阶段路由
  - 阶段 1：关键词正则匹配（快速路径，命中率目标 > 70%）
  - 阶段 2：LLM 语义判断兜底
- 先只实现 `research` vs `default` 两个路由分支，后续扩展其他智能体时追加规则

**验证**：输入研究类问题被正确路由到 Research Agent，其他问题走 Default Agent

#### 7. Agent 配置文件目录

- `config/agents/` 目录，每个专家一个 YAML 配置文件
- 首个文件：`config/agents/research.yaml` — 包含 system prompt、技能列表、MCP 依赖、模型偏好、安全配置

**验证**：Research Agent 从 YAML 配置加载成功

---

### P2 — 测试与文档（不阻塞主流程）

#### 8. 冒烟测试扩展

- `src/smoke-test.ts` 新增测试：MCP Manager 注册 / 发现、路由器关键字匹配、Research Agent 配置加载
- 目标：断言数从 39 增长到约 50+

**验证**：`npm test` 通过

#### 9. AGENTS.md 更新

- 补充 MCP Manager、路由器等新增模块说明

---

## 依赖关系

```
P0: ① MCP Manager ─┬─→ ⑤ Research Agent
    ② web_search   ─┤
    ③ Memory       ─┤
    ④ onError      ─┘
                      ↓
P1: ⑥ 专家路由器 ←───→ ⑦ config/agents/
                      ↓
P2: ⑧ 扩展测试    ⑨ AGENTS.md
```

---

## 文件产出清单

```
src/mcp/
  mcp-manager.ts               # 新增
  connection-pool.ts           # 新增
src/agents/
  router.ts                    # 新增
  research-agent.ts            # 新增
src/tools/builtin.ts           # 修改（web_search 替换实现）
src/core/agent-loop.ts         # 修改（补充 onError hook 触发）
src/memory/compressor.ts       # 修改（写入 MEMORY.md）
config/
  agents/
    research.yaml              # 新增
```
