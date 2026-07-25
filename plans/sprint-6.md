# Sprint 6 — 补全 Phase 2 四个缺口

> **目标**：上下文压缩器 LLM 化、Agent YAML 加载、MCP 连接池/健康检查、Hooks 配置化
> **预计**：4 个模块，~2h

---

## 模块 1: 上下文压缩器集成 LLM

**现状**: `new ContextCompressor()` 无参，`generateSummary()` 永远不会调用

**方案**:
- `src/index.ts`: 创建 `ModelProvider` 回调 → 传入 `ContextCompressor`
- `src/memory/compressor.ts`: 移除硬编码 `model: "gpt-4o-mini"`

**改动文件**: 2

---

## 模块 2: Agent YAML 配置加载

**现状**: `config/agents/*.yaml` (6个) 存在，`yaml` 包已安装

**方案**:
- 新建 `src/core/agent-config-loader.ts`: `loadAgentConfig(id)` → YAML → AgentConfig
- 7 个 Agent 类: 构造器先 YAML，fallback 硬编码

**改动文件**: 1 新建 + 7 修改 = 8

---

## 模块 3: MCP 连接池与健康检查

**现状**: `McpManager` 无断线重连

**方案**:
- 新建 `src/mcp/connection-pool.ts`: 连接状态机 + 指数退避重连
- 新建 `src/mcp/health-check.ts`: 定时 ping → 连续失败触发重连
- 修改 `src/mcp/mcp-manager.ts`: 集成两者

**改动文件**: 2 新建 + 1 修改 = 3

---

## 模块 4: Hooks 配置化

**现状**: 11 个 handler 设计中仅实现 1 个 (dangerousCommandBlock)

**方案**:
- 新建 `config/hooks.json`: 声明式 hook 配置
- 新建 `src/hooks/hook-config-loader.ts`: JSON → hookManager.on()
- 新建 `src/hooks/handlers.ts`: 6 个核心 handler 实现 + 5 个 stub
- 修改 `src/index.ts`: 抽出硬编码 hook

**改动文件**: 3 新建 + 1 修改 = 4

---

## 测试

- `npm run build` → 无编译错误
- `npm test` → 59 tests pass
- 可选: 在 smoke-test.ts 中新增 agent-config-loader / hook-config-loader 测试

**改动文件总计**: ~15
