# Sprint 9: MCP 服务器配置

---

## 一、动机

MCP Manager 已完整实现（stdio/HTTP、工具发现、健康检查、自动重连），但 `config/mcp.json` 的 `servers: {}` 为空，从未接入过外部服务。本 Sprint 打通端到端 MCP 管道，并添加新工具。

## 二、设计原则

内置工具（fs_read/write/list、terminal_exec、web_search/fetch）**不走 MCP**——它们是同进程直接函数调用，走 MCP 只增加 IPC 开销（~10-20ms/次）而无收益。MCP 留给真正的外部服务。

## 三、新增内容

### 3.1 轻量 MCP 工具服务器 (`src/mcp/builtin-server.ts`)

一个最小化 MCP stdio 服务器，提供内置没有的工具：

| 工具 | 说明 |
|------|------|
| `math_eval` | 计算数学表达式 |
| `uuid_gen` | 生成 UUID |
| `json_format` | 格式化/验证 JSON 字符串 |
| `timestamp_convert` | 时间戳 ↔ 日期转换 |

实现：JSON-RPC 2.0 over stdin/stdout，符合 MCP 2024-11-05 协议。

### 3.2 `config/mcp.json` 配置

```json
{
  "servers": {
    "builtin": {
      "transport": "stdio",
      "command": "npx",
      "args": ["tsx", "src/mcp/builtin-server.ts"],
      "enabled": true
    }
  }
}
```

外部服务器（GitHub、Brave Search 等）配置模板以注释形式保留。

### 3.3 CLI 集成 (`src/index.ts`)

- 启动时加载 `config/mcp.json`
- 已连接到 MCP 服务器 → 显示 `✓ MCP: builtin (4 工具, 已连接)`
- 连接失败 → 静默降级，不影响启动

## 四、性能说明

MCP stdio 工具调用比直接函数调用多 10-20ms IPC 开销。但 LLM 延迟（100ms-2s/次）主导总耗时，此开销忽略不计。MCP 的价值在于**外部服务接入**（跨进程、跨语言、第三方），不是替代内置工具。

## 五、修改文件

| 文件 | 变更 |
|------|------|
| `src/mcp/builtin-server.ts` | **新建** — MCP stdio 工具服务器 |
| `config/mcp.json` | 配置 builtin 服务器 + 外部模板 |
| `src/index.ts` | 启动时 `loadConfig` + MCP 状态展示 |

## 六、测试计划

| 测试 | 说明 |
|------|------|
| MCP 服务器 spawn 成功 | builtin-server 子进程正常启动 |
| 工具发现 | `tools/list` 返回 4 个工具 |
| `math_eval` 调用 | `2+3*4` → `14` |
| `uuid_gen` 调用 | 返回合法 UUID v4 |
| `json_format` 调用 | 格式化 + 错误检测 |
| `timestamp_convert` 调用 | 双向转换 |
| CLI 状态展示 | MCP 状态出现在启动输出中 |
