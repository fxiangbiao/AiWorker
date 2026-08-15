# Sprint 27 — 插件契约 + scoped 工具注册（报告 #1 + #2）

> 承接报告 `docs/comparison-report.md` 剩余差距：
> - **#1** 无插件机制，扩展成本高 → 轻量插件契约（`config/plugins/` 目录加载能力提供者，不上 Cordis）
> - **#2** 工具注册为全局单例，无作用域 → 按 agent 分层遮蔽（scoped registry，对齐 DSH `ToolRuntime` 作用域语义）
>
> 用户已选定本批；先计划后实施。

---

## 现状确认（已读代码）

| 事实 | 位置 |
|---|---|
| 模型工具定义 = **全局全部**（8 内置 + MCP 工具），不区分专家 | `agent-loop.ts` L84/L276 `toolRegistry.getAvailableDefinitions(toolCtx)` |
| `AgentConfig.tools`（各 agent YAML 的 `tools:`）**未被使用**，只有 `allowedTools` 在执行时拦截 | `agent-config-loader.ts` L42；`agent-loop.ts` L617 |
| YAML `tools:` 仅 coding/financial 非空，default（TS 内置）6 个，research/data-analysis/product-ops/game-dev 为空 | `config/agents/*.yaml`、`default-agent.ts` L35 |
| MCP 工具注册名 `mcp_<server>_<tool>`（全局） | `mcp-manager.ts` L196 |
| `hookManager` 已有运行时 `on(event, handler, {id, priority})` API，插件注册 hook 无障碍 | `hook-manager.ts` L34 |
| CLI 命令注册表数组组装，命令直接 import 单例（零闭包） | `commands/registry.ts`、`misc.ts`（`/mcps` 参照） |
| Server 端点 `if (url === apiUrl("/x"))` 模式 + `ServerDeps` 注入 | `server.ts` L30/L307 |

**兼容性结论**：白名单过滤只对 coding/financial/default 生效（tools 非空）；其余 4 个 agent tools 为空 → 保持"全部可见"现状，零行为变化风险。ask 模式语义保留（白名单内的写工具仍可见 → 尝试 → permissionCheck 拦截告警）。

---

## A. ToolRegistry 作用域视图（scoped registry）

**新 API**（`src/core/tool-registry.ts` 扩展，类内新增，不破坏现有调用）：

```ts
class ToolRegistry {
  private scopes = new Map<string, Map<string, RegisteredTool>>();

  /** 获取命名作用域视图（scope 注册表 + 全局回退，同名遮蔽全局） */
  getScope(scopeId: string): ToolScopeView;
  /** 列出所有 scope 注册的工具（供 /plugins 与调试） */
  listScopeTools(scopeId: string): RegisteredTool[];
}

class ToolScopeView {
  register(name, definition, handler, options?): void;      // scope 内注册，遮蔽全局同名
  unregister(name): boolean;
  setEnabled(name, enabled): void;
  getAll(): RegisteredTool[];
  getAvailableDefinitions(ctx): Promise<ToolDefinition[]>;   // scope ∪ 全局（scope 同名遮蔽）
  getHandler(name): RegisteredTool["handler"] | undefined;   // scope 优先，回退全局
  isAvailable(name): boolean;
}
```

- 语义对齐 DSH：scope 内同名工具**遮蔽**全局（模型与执行都走 view，保证一致性）。
- 全局注册表仍为根；内置/MCP 工具保持全局（所有 view 回退可见）。

## B. agent 工具可见性白名单（"专家只见自己的工具"）

`agent-loop.ts` 两处（`runAgentLoop` / `runAgentLoopStream`）改造：

1. `AgentLoopDeps` 增加 `toolScope?: string`；组装工具定义时：
   ```ts
   const view = deps.toolScope ? toolRegistry.getScope(deps.toolScope) : toolRegistry;
   let tools = await view.getAvailableDefinitions(toolCtx);
   // agent 白名单收窄（tools 非空时）：仅保留白名单工具 + MCP 工具（mcp_ 前缀保持全局可见，行为不变）
   if (config.tools.length > 0) {
     tools = tools.filter((t) => config.tools.includes(t.function.name) || t.function.name.startsWith("mcp_"));
   }
   ```
2. `executeToolInner` 的 `toolRegistry.getHandler(toolName)` → 传入同一 view 解析（遮蔽生效）。

**BaseAgent**：`run`/`runStream` 传 `toolScope: this.config.id`（每个 agent 一个命名 scope；无 scope 注册时 = 全局回退，现状不变）。TeamCoordinator 各步天然按专家隔离。

## C. 插件契约（`config/plugins/`）

**新文件** `src/core/plugin-manager.ts`：

```ts
export interface PluginInfo {
  name: string;                 // 目录名
  version?: string;
  description?: string;
  entry: string;                // 实际加载的入口文件
  status: "loaded" | "error";
  error?: string;
  registeredTools: string[];
  registeredHooks: number;
}

export interface PluginContext {
  name: string;
  dataDir: string;
  /** config/plugins/<name>/config.json（存在则解析，含 BOM 清理） */
  config: Record<string, unknown>;
  /** 注册工具；scope 可选（缺省全局），同名遮蔽规则由 ToolScopeView 保证 */
  registerTool(name, definition, handler, options?: { scope?: string; enabled?: boolean; availabilityCheck? }): void;
  registerHook(event, handler, options?: { id?: string; priority?: number }): string;  // 委托 hookManager.on
}

export class PluginManager {
  loadFromDir(dir: string, opts?: { dataDir?: string }): Promise<{ loaded: number; failed: number }>;
  getPlugins(): PluginInfo[];
  getPlugin(name: string): PluginInfo | undefined;
}
export const pluginManager = new PluginManager();
```

**插件格式**（零框架依赖，契约即"默认导出一个 setup 函数"）：

```
config/plugins/<name>/
├── plugin.ts | plugin.js | index.ts | index.js   ← 入口（.ts 优先，按序探测）
├── config.json                                  ← 可选，注入 ctx.config
```

```ts
// config/plugins/hello/plugin.ts
export default async function setup(ctx: PluginContext) {
  ctx.registerTool("hello", {
    type: "function",
    function: { name: "hello", description: "打个招呼", parameters: { type: "object", properties: {} } },
  }, async (_args, toolCtx) => ({ tool_call_id: "", success: true, content: `你好，${toolCtx.agentId}！` }));
}
```

- 加载：`import(pathToFileURL(entry).href)` → `mod.default ?? mod.setup`，非函数 → 记录 error。
- **fail-soft**：单个插件失败记录 `{status:"error", error}`，不阻断启动，启动横幅打 ⚠ 告警。
- 模块缓存（Map）防重复加载；注册工具自动记录归属插件名（`RegisteredTool` 加可选 `plugin?: string`）。
- 安全说明（README）：插件 = 任意进程权限代码，仅加载可信插件（与 DSH 插件体系同定位）。

**dev 用 tsx 运行，.ts/.js 插件均可 import；编译后（node dist）仅 .js 插件可用**（README 注明）。

## D. CLI `/plugins` + Web API

- **`/plugins` 命令**（新 `src/commands/plugins.ts`，注册进 `registry.ts` misc 组）：列出 name/version/description/status（loaded ✓ / error ✗ + error），`/help` 与 Tab 补全自动生成。直接 `import { pluginManager }`（单例，符合零闭包约定）。
- **`GET /api/v1/plugins`**：`ServerDeps` 加 `getPlugins?: () => PluginInfo[]`；`server.ts` 端点返回 `{ plugins: [...] }`。
- Web SystemPanel 展示插件列表：**列为可选二期**（API 已就绪，UI 改动小但本期聚焦核心）。

## E. index.ts 接入

`registerBuiltinTools()` 之后、MCP 加载附近：

```ts
const pluginsDir = resolve(process.cwd(), "config", "plugins");
const pluginSummary = await pluginManager.loadFromDir(pluginsDir, { dataDir });
// 启动横幅：✓ 已加载 N 个插件 / ⚠ 插件加载失败: name(error)
```

server 分支的 `startServer` deps 增加 `getPlugins: () => pluginManager.getPlugins()`。

---

## 兼容性 / 行为变化

- coding/financial/default：模型不再见白名单外内置工具（web_fetch 等）→ 更聚焦，符合"专家只见自己的工具"；**执行拦截逻辑（allowedTools/deniedTools）不变**。
- research 等 4 个 agent：tools 为空 → 全部可见（现状不变）。
- MCP 工具：`mcp_` 前缀保留，所有 agent 可见性不变。
- ask 模式：白名单内写工具仍可见 → 尝试 → permissionCheck 拦截告警（语义保留）。
- 工具可见性收窄如需回退：清空该 agent YAML 的 `tools:` 即可（空 = 全部可见）。

## 测试计划

| 文件 | 用例 |
|---|---|
| `test/tool-registry.test.ts`（新） | scope 创建 / 同名遮蔽全局（get/getAll/getHandler/isAvailable/getAvailableDefinitions）/ unregister / 全局回退 |
| `test/plugin-manager.test.ts`（新） | 临时目录 `data-test/plugins-test/<name>/plugin.ts`：setup 调用、registerTool 后全局可见、registerHook 生效、config.json 注入、入口缺失/导出非函数 → status error 不抛、.js 插件、重复加载幂等 |
| `test/agent-loop.test.ts`（扩展） | config.tools 白名单过滤（mock registry：非白名单工具被滤、`mcp_` 工具保留）；`toolScope` 传参时经 scope view 取定义与 handler |
| `test/cli-commands.test.ts`（扩展） | `/plugins` 命令：加载后输出插件名、失败插件显示 error |
| `test/server.test.ts`（扩展） | `GET /api/v1/plugins` 返回列表（deps 注入 getPlugins mock） |

全量回归：`tsc --noEmit` / `eslint src/ test/` / `vitest` / `npm run web:build`。

## 提交计划

1. `feat(core): ToolRegistry 作用域视图 + agent 工具可见性白名单`（A+B+agent-loop/BaseAgent）
2. `feat(plugins): config/plugins 插件管理器 + /plugins 命令 + /api/v1/plugins`（C+D+E）
3. `docs: README 插件开发章节 + AGENTS.md 同步`（插件示例、安全提示、scope 说明）

## 执行记录

**实施偏差**（相对初始方案）：
- 插件导出支持两种形态：`setup(ctx)` 函数 或 `{ setup, version, description }` 对象（版本/描述可声明，README 示例含对象形态）
- `PluginManager.clear()` 补充（测试隔离/重载用）
- 可见性白名单实际只影响 coding/financial/default（`config.tools` 非空），research 等 4 个 agent tools 为空 → 全部可见（与计划兼容性分析一致）

**新增/改动文件**：
- 新增：`src/core/plugin-manager.ts`（PluginManager + PluginContext，fail-soft + 幂等）、`src/commands/plugins.ts`（/plugins 命令）、`test/tool-registry.test.ts`（6 例）、`test/plugin-manager.test.ts`（9 例）
- 改动：`types.ts`（RegisteredTool.plugin + PluginInfo/PluginContext）、`tool-registry.ts`（scopes map + ToolScopeView + getScope/listScopeTools，clear 清 scope）、`agent-loop.ts`（AgentLoopDeps.toolScope + filterVisibleTools 白名单 + executeTool 传 view）、`base-agent.ts`（run/runStream 传 toolScope: config.id）、`commands/registry.ts`（注册 pluginsCommands）、`server.ts`（ServerDeps.getPlugins + GET /api/v1/plugins）、`index.ts`（插件加载 + 启动横幅 + server deps）
- 测试扩展：`agent-loop.test.ts`（白名单过滤 + mcp_ 保留 + tools 空不过滤 + toolScope 遮蔽，+3）、`cli-commands.test.ts`（/plugins 2 例）、`server.test.ts`（/api/v1/plugins 2 例）
- 文档：README「插件开发」章节 + HTTP API/项目结构/配置表；AGENTS.md 模块速览/命令表/测试段

**测试**：全量 **322 通过**（22 文件；原 300 + 新增 22）。
**验证**：`tsc --noEmit` 0 错误；`eslint src/ test/` 0 警告；`vitest` 322 通过；`npm run web:build` 成功。

**修复迭代（实机验证发现）**：
- 同名冲突警告（`PluginInfo.warnings` + `/plugins` ⚠ 展示，e629900）
- 示例插件补充 registerHook（example 工具调用日志，b7e4e6f）；hello 插件修复 `hc.log` 不存在的方法调用（2d2deb9）
- **插件工具豁免可见性白名单**：实机测试发现模型看不到 `now` 插件工具（被 coding agent 的 `config.tools` 白名单过滤，只能绕路 terminal_exec）→ `filterVisibleTools` 增加插件工具豁免（`isPluginTool`，与 `mcp_` 同待遇）；内置工具仍按白名单裁剪，scope 注册仍可限定专家；端到端验证 coding agent 模型可见 `now/greeting/hello`
