# Sprint 19: TUI 修复 + CLI 增强 + 测试重构

> 修复 TUI 输入行/分隔线消失根因、增强 /skills /log /config 命令、按模块拆分测试、按 DeepSeek 官方文档修正模型配置。

---

## 一、目标摘要

解决 Sprint 18 遗留的 TUI 布局破坏根因（内嵌换行符 + partial 空行覆盖），补齐 CLI 命令能力（技能描述、监控日志指标、模型运行时配置），将单文件测试拆分为模块化 test/ 目录，并依据 DeepSeek 官方文档修正 maxTokens 与思考模式配置。

## 二、任务拆分

### T1: TUI 输入行/分隔线消失修复 ⭐⭐ (P0)
**修改 `src/terminal/components.ts`、`src/hooks/handlers.ts`、`config/hooks.json`**
- 根因 1：`append()` 空行覆盖流式 partial 行 → 空行总是追加
- 根因 2：`appendInline()` 含 `\n` 的 chunk 直接拼入单行破坏帧布局 → 按 `\n` 拆分，`wrapLines` 防御性拆分
- turnLogger 注册到 `onMessage`（记录真实耗时/token 增量）

### T2: /skills 技能描述 (P1)
**修改 `src/types.ts`、`src/core/skill-registry.ts`、`src/index.ts`、38 个 SKILL.md**
- `SkillDef` 加 `description` 字段，frontmatter 优先、`#` 标题 fallback
- `/skills` 按专家分组 + 名称对齐 + 描述

### T3: /log 监控日志修复 (P1)
**修改 `src/memory/session-store.ts`、`src/hooks/handlers.ts`、`src/index.ts`**
- `getRecentTurnLogs()` 回退最近会话（currentSessionId 为空时）
- turnLogger 真实耗时 + 当轮 token 增量（非累计值）
- `/log` 表格重做：动态列宽 + 输入/输出 token 列 + 时长格式化

### T4: /config 模型配置命令 ⭐⭐ (P0)
**修改 `src/core/model-router.ts`、`src/index.ts`、`config/models.json`**
- 运行时覆盖：profile key/temperature/maxTokens，持久化 `data/runtime-config.json`
- `/config` 查看 + `model <名>` / `temperature <0-2>` / `max-tokens <n>` / `reset`
- `thinking` 经 `extra_body` 传递，mergeProfile 隔离供应商专属参数

### T5: 测试拆分到 test/ (P1)
**新建 `test/*.ts` 9 文件 + `test/helpers.ts`，删除 `src/smoke-test.ts`，修改 `vitest.config.ts`**
- 按模块拆分 16 个 describe，共享 `makeTestDir` 独立 data 目录防并行冲突

### T6: DeepSeek 配置按官方文档修正 (P2)
**修改 `config/models.json`、`src/core/model-router.ts`**
- maxTokens 4096→16384（官方：上下文 1M、输出最大 384K）
- default 启用 thinking 模式（官方：思考模式下 temperature 无效）

## 三、文件变更清单

**新建**：`test/core.test.ts`、`test/memory.test.ts`、`test/hooks.test.ts`、`test/tools.test.ts`、`test/mcp.test.ts`、`test/team.test.ts`、`test/streaming-terminal.test.ts`、`test/tui.test.ts`、`test/skill-evolution.test.ts`、`test/helpers.ts`

**修改**：`src/types.ts`、`src/core/model-router.ts`、`src/core/skill-registry.ts`、`src/hooks/handlers.ts`、`src/memory/session-store.ts`、`src/index.ts`、`src/terminal/components.ts`、`config/hooks.json`、`config/models.json`、`vitest.config.ts`、`AGENTS.md`、38 个 SKILL.md

**删除**：`src/smoke-test.ts`

## 四、依赖关系图

```
T1 (TUI 修复) ──────┐
T3 (/log 指标) ────┤  → T5 (测试拆分，覆盖全部回归)
T2 (/skills 描述) ─┘
T4 (/config) ──────┐
T6 (DeepSeek 配置) ─┘  → T5 (新增 ModelRouter 配置测试)
```

## 五、验证标准

- `npm test` 全绿（135+ 项）
- `npx tsc --noEmit` 零错误
- `npx eslint src/ test/` 零错误
- `npm run build` 通过
- 手动验证：TUI 输入行/分隔线不消失、/skills 对齐、/log token 列、/config 持久化生效

## 六、风险与对策

| 风险 | 对策 |
|------|------|
| 测试并行 worker 写同一 data-test 目录 | 每文件独立子目录（makeTestDir） |
| DeepSeek thinking 参数经 extra_body 传递的 SDK 兼容性 | 拦截 client.create 验证 extra_body 正确 |
| runtime-config.json 旧格式（model 字段） | applyOverrides 兼容 profile + model 双字段 |
| turnLogger onMessage 并发子 agent token 归因偏差 | 各 sub-agent 独立 sessionId + 独立基线 |


---

## 执行记录

| 日期 | 阶段 | 状态 | 备注 |
|------|------|------|------|
| 2026-08-07 | T1 TUI 修复 | ✅ | append 空行不覆盖 partial；appendInline 按 \n 拆分；wrapLines 防御拆分 |
| 2026-08-07 | T2 /skills | ✅ | 38 个 SKILL.md 注入 description + fallback 标题 |
| 2026-08-07 | T3 /log | ✅ | getRecentTurnLogs 回退 + 真实耗时 + token 增量 + 表格 token 列 |
| 2026-08-07 | T4 /config | ✅ | profile/temperature/maxTokens 运行时覆盖 + 持久化；Code Review 修复 P1（model→profile key） |
| 2026-08-07 | T5 测试拆分 | ✅ | 9 文件 + helpers，135 测试全绿 |
| 2026-08-07 | T6 DeepSeek 配置 | ✅ | maxTokens 16384 + thinking 模式（extra_body） |
| 2026-08-07 | Code Review | ✅ | 修复 1 P1（/config model lite provider 未切换）+ 3 P2（turnStart 泄漏/tests/AGENTS.md）；补审 T5+T6 通过 |
| 2026-08-07 | 阶段 4 验证 | ✅ | 135 tests / tsc / eslint / build 全绿 |
