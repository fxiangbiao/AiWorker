# Sprint 2 — Skills 技能系统

> **目标**：建设 SKILL.md 技能基础设施，让 Research Agent 具备结构化工作流能力
> **周期**：1 天
> **交付物**：SkillRegistry 核心 + 6 个 SKILL.md + Context 集成

---

## 任务拆解

### P0 — 核心基础设施

#### 1. SkillRegistry 单例

- `src/core/skill-registry.ts` — 单例模式（仿 ToolRegistry / HookManager）
- 功能：
  - `loadFromDir(dir)` — 递归加载 `skills/` 目录下所有 `SKILL.md`
  - `match(input, agentId)` — 根据用户输入正则匹配技能
  - `getAvailableSkills(agentId, ctx?)` — 过滤掉依赖不满足的技能（auto-degradation）
  - `getInjectedPrompt(agentId, userInput?)` — 生成注入 system prompt 的文本
- 依赖：`yaml` 解析 frontmatter

**验证**：加载 `skills/` 目录返回正确数量，match 结果准确

#### 2. SKILL.md 格式定义

```yaml
---
name: skill-name
version: "1.0"
triggers:           # 触发关键词（正则）
  - keyword|pattern
expert: research    # 所属智能体，common 为通用
tools_required:     # 依赖工具列表
  - web_search
model_preference: reasoning  # 可选
---

# Markdown 正文（工作流说明）
```

**验证**：`parseSkillFile()` 正确解析 YAML frontmatter + Markdown body

#### 3. ContextManager 集成

- `assembleContext()` 新增 `agentId` 参数
- 在 system prompt 组装链路中注入匹配的技能说明
- 注入位置：语义记忆 → 历史摘要 → **技能列表** → 用户消息

**验证**：Research Agent 的 conversation 中包含技能指引

---

### P1 — SKILL.md 文件

#### 4. Research 专用技能（5 个）

| 技能 | 目录 | 触发词 |
|------|------|--------|
| web-deep-search | `skills/research/web-deep-search/` | 搜索、查找、检索、search |
| competitive-analysis | `skills/research/competitive-analysis/` | 对比、比较、vs、竞品 |
| trend-forecasting | `skills/research/trend-forecasting/` | 趋势、预测、前景 |
| report-generation | `skills/research/report-generation/` | 报告、总结、汇总 |
| citation-tracking | `skills/research/citation-tracking/` | 引用、来源、参考 |

**验证**：每个文件包含合法 YAML frontmatter + 结构化工作流说明

#### 5. Common 通用技能（1 个）

| 技能 | 目录 | 触发词 |
|------|------|--------|
| file-organization | `skills/common/file-organization/` | 创建文件、保存、输出 |

**验证**：跨智能体可用

---

### P2 — CLI 加载 & 测试

#### 6. CLI 启动时加载技能

- `index.ts` 中调用 `skillRegistry.loadFromDir("skills/")`
- 启动日志输出已加载技能数量

#### 7. 冒烟测试扩展

- SkillRegistry 加载、匹配、prompt 生成测试用例
- 目标：从 38 测试增长到 43+

---

## 依赖关系

```
① SkillRegistry → ② SKILL.md 格式 → ③ ContextManager 集成
                                     ↓
④ Research SKILL.md × 5  ⑤ Common SKILL.md × 1
                                     ↓
⑥ CLI 加载    ⑦ 测试扩展
```

---

## 文件产出清单

```
src/core/
  skill-registry.ts                      # 新增
  context-manager.ts                     # 修改（+agentId 参数 + skills 注入）
  agent-loop.ts                          # 修改（传递 agentId）
src/
  index.ts                               # 修改（启动时加载 skills）
  types.ts                               # 修改（+SkillDef 类型）
  smoke-test.ts                          # 修改（+SkillRegistry 测试）
skills/
  common/file-organization/SKILL.md      # 新增
  research/web-deep-search/SKILL.md      # 新增
  research/competitive-analysis/SKILL.md # 新增
  research/trend-forecasting/SKILL.md    # 新增
  research/report-generation/SKILL.md    # 新增
  research/citation-tracking/SKILL.md    # 新增
AGENTS.md                                # 修改（+Skills 章节）
```
