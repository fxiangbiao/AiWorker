# Sprint 3 — Coding 编码智能体

> **目标**：交付 Coding Agent，覆盖编码/调试/重构/测试场景，成为第二个高频专家智能体
> **周期**：1 天
> **交付物**：CodingAgent + 3 skills + 路由规则 + 安全强化

---

## 任务拆解

### P0 — 核心实现

#### 1. Coding Agent 实现

- `src/agents/coding-agent.ts` — 继承 `BaseAgent`
- System prompt：全栈高级工程师人设
  - 擅长架构设计、代码重构、调试排错、单元测试
  - 优先阅读项目现有代码风格，保持一致性
  - 操作前先确认文件状态和依赖关系
- 模型偏好：`coding`，最大迭代 50 次
- 工具白名单：`fs_read`、`fs_write`、`fs_list`、`terminal_exec`、`web_search`

**验证**：构造完成不报错，配置正确

#### 2. Agent 配置文件

- `config/agents/coding.yaml`
- 内容：system prompt、模型偏好、工具列表、权限配置、安全级别 HIGH

**验证**：YAML 格式正确，字段完整

#### 3. 路由器追加规则

- `router.ts` — 追加 coding 关键词路由规则
  - 编码关键词：编写、开发、实现、写代码、修复、调试、重构、测试、优化、报错
  - English：code、develop、fix、debug、refactor、test、optimize
  - 具体操作词：创建.*函数、新建.*组件、添加.*功能
- 权重设为 90（高于 research 的 80），编码意图更明确

**验证**：编码类输入正确路由到 `coding`，非编码类不受影响

#### 4. CLI 注册

- `index.ts` — `agents` map 中注册 `CodingAgent`
- 启动日志：`✓ 专家智能体: 通用助手, 研究分析师, 编码工程师`

**验证**：`npm run build` 通过，编码输入触发 Coding Agent

---

### P1 — Skills 扩展

#### 5. Coding 技能 × 3

| 技能 | 目录 | 触发词 | 工具依赖 |
|------|------|--------|----------|
| code-review | `skills/coding/code-review/` | 审查、review、检查代码 | fs_read |
| debug | `skills/coding/debug/` | 调试、debug、报错、bug、修复 | fs_read、terminal_exec |
| test-generation | `skills/coding/test-generation/` | 测试、test、用例、覆盖 | fs_read、fs_write、terminal_exec |

**验证**：skillRegistry 加载成功，match 返回对应技能

#### 6. 安全强化

- Coding Agent 安全级别：HIGH
  - `deniedTools` 默认禁止 `rm`、`sudo` 等危险操作
  - `allowedTools` 白名单机制
  - 高危操作仍需确认

**验证**：Coding Agent 调用危险工具被拦截

---

### P2 — 测试与文档

#### 7. 冒烟测试扩展

- 路由器：coding 关键词匹配 5+ 用例
- Coding Agent：配置加载验证
- 目标：43 → 50+ 测试

#### 8. AGENTS.md / README 更新

- AGENTS.md：更新 agent 列表
- README：Phase 2 进度更新

---

## 依赖关系

```
① Coding Agent ─┬─→ ② YAML 配置
                ├─→ ③ 路由规则
                └─→ ④ CLI 注册
                         ↓
⑤ Skills × 3    ⑥ 安全强化
                         ↓
⑦ 测试扩展       ⑧ 文档更新
```

---

## 文件产出清单

```
src/agents/
  coding-agent.ts                     # 新增
router.ts                             # 修改（追加 coding 路由规则）
config/agents/
  coding.yaml                         # 新增
src/
  index.ts                            # 修改（注册 CodingAgent）
skills/coding/
  code-review/SKILL.md                # 新增
  debug/SKILL.md                      # 新增
  test-generation/SKILL.md            # 新增
src/
  smoke-test.ts                       # 修改（路由 + 配置测试）
AGENTS.md                             # 修改
README.md                             # 修改
```
