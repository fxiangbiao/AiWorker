# Sprint 12：技能自进化 v2 + 工程化增强 + API Server

> 目标：完成 M2.1 技能自进化（LLM 知识提取），补齐 ESLint/Prettier 工程化基础设施，扩展测试覆盖，增加 HTTP API 模式。
> 预计工时：~17-24h（5 个模块）

---

## 一、现状

- 85 测试全绿，tsc 零错误
- M2.1 技能自进化 v2 是唯一功能缺口：当前 `skill-evolution.ts` 为模板空壳
- 无 ESLint/Prettier，代码风格一致性靠人工
- 测试仅 1 个 smoke-test.ts，核心模块缺少单元测试
- 仅 CLI 模式，无可编程 API

---

## 二、任务拆解

### T1: ESLint + Prettier（先做，影响所有后续代码）

| 子任务 | 说明 |
|--------|------|
| 安装依赖 | `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-config-prettier`, `prettier` |
| 配置 | `eslint.config.mjs`（flat config）+ `.prettierrc` |
| npm scripts | `lint`, `lint:fix`, `format` |
| 修复现有代码 | 一次 `--fix` 格式化整个 `src/` |

### T2: M2.1 技能自进化 v2

| 子任务 | 说明 |
|--------|------|
| 重写 `skill-evolution.ts` | 接入 ModelRouter，LLM 分析 messages |
| LLM prompt 设计 | 要求输出结构化 YAML frontmatter + Markdown body |
| 去重检测 | 检查现有技能，相似度 > 阈值跳过 |
| 质量评分 | LLM 自评 1-5 星 |
| Hook 集成 | 重写 `createEvaluateSkillCreation` handler |

**LLM 提取字段**：
- `name`：技能名（kebab-case）
- `triggers`：3-5 个正则触发词
- `expert`：对应智能体
- `tools_required`：需要的工具列表
- Body：问题域、解决方案步骤、常见陷阱、代码示例

### T3: 测试扩展

| 模块 | 覆盖点 |
|------|--------|
| `agent-loop.test.ts` | 断路器、token 压缩、空响应终止 |
| `context-manager.test.ts` | 组装、截断、profile 提取 |
| `session-store.test.ts` | FTS5 搜索、CRUD |
| `handlers.test.ts` | 权限检查、审计日志、turnLogger |
| `tools.test.ts` | coerceToolArgs 边界、路径遍历 |

### T4: API/HTTP Server 模式

| 子任务 | 说明 |
|--------|------|
| 服务层 | `src/server.ts`，内置 `node:http` |
| 端点 | `POST /chat`（SSE）、`GET /status`、`GET /tools` |
| 会话管理 | 每个请求独立 Agent session |
| CLI | `--server` / `--port` |

### T5: 低优修复项评估

Code Review 未修复项（#4, #22, #24, #26, #27, #28, #32, #35）在会话中讨论但未存档。全项目扫描结果：
- 无残留 TODO/FIXME/HACK 注释
- 无 console.log/error/warn 生产代码
- eslint 零, tsc 零, 92 测试绿
- **结论**: 已自然解决或评估后放弃，无需修复。

---

## 三、执行记录

| 日期 | 内容 | 提交 |
|------|------|------|
| 2026-08-01 | T1: ESLint + Prettier | `d2fe26f` |
| 2026-08-01 | T2: M2.1 技能自进化 v2 | `7abb130` |
| 2026-08-01 | T3: SkillEvolution 单元测试 (7 tests) | `6e89223` |
| 2026-08-01 | T4: HTTP Server API 模式 | `194357f` |
| 2026-08-01 | T5: 低优修复项评估 | 无需修复 |
