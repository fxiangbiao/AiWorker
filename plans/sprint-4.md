# Sprint 4 — 剩余 4 个专家智能体

> **目标**：一次性交付 Data Analysis + Product Ops + Financial + Game Dev，完成 Phase 2 六大专家全部就位
> **周期**：1 天
> **交付物**：4 Agent + 28 Skills + 路由规则

---

## 任务拆解

### P0 — 4 个 Agent 实现

#### 1. Data Analysis 数据分析智能体

- `src/agents/data-analysis-agent.ts`
- System prompt：数据科学家人设，擅长数据清洗、统计建模、可视化
- 模型偏好：`coding`，最大迭代 60 次
- 工具：`fs_read`、`fs_write`、`terminal_exec`（调用 Python）、`web_search`
- 安全：HIGH（执行 Python 代码），`deniedTools` 默认限制危险命令

**验证**：构造通过，配置正确

#### 2. Product Ops 产品运营智能体

- `src/agents/product-ops-agent.ts`
- System prompt：产品经理人设，擅长 PRD、用户调研、竞品分析、内容创作
- 模型偏好：`writing`，最大迭代 40 次
- 工具：`fs_read`、`fs_write`、`web_search`、`web_fetch`
- 安全：MEDIUM（读写文件），默认 `plan` 模式

**验证**：构造通过，配置正确

#### 3. Financial 理财投资智能体

- `src/agents/financial-agent.ts`
- System prompt：金融分析师人设，A 股惯例（红涨绿跌、人民币、免责声明）
- 模型偏好：`reasoning`，最大迭代 60 次
- 工具：`web_search`、`web_fetch`、`fs_read`、`fs_write`
- 安全：LOW（只读为主），默认 `ask` 模式，写报告需确认
- 特殊约束：所有建议附带免责声明"本文不构成投资建议"

**验证**：构造通过，配置正确

#### 4. Game Dev 游戏开发智能体

- `src/agents/game-dev-agent.ts`
- System prompt：游戏设计师人设，Godot 4.x 知识、GDScript、数值平衡
- 模型偏好：`creative`，最大迭代 70 次
- 工具：`fs_read`、`fs_write`、`fs_list`、`terminal_exec`、`web_search`
- 安全：HIGH，默认 `plan` 模式
- 知识库嵌入：Godot 4.x 关键 API、游戏设计模式（状态机/组件/ECS）

**验证**：构造通过，配置正确

---

### P0 — 路由 & 配置 & CLI

#### 5. 路由器追加规则

在 `router.ts` 追加 4 组关键词规则：

| Agent | 权重 | 关键词示例 |
|-------|:--:|------|
| data-analysis | 70 | 数据分析、统计、可视化、清洗、图表、SQL、pandas |
| product-ops | 60 | PRD、产品需求、用户调研、运营、文案、内容创作、A/B测试 |
| financial | 75 | 股票、基金、投资、理财、估值、K线、行情、ETF、财报 |
| game-dev | 65 | 游戏设计、关卡、GDScript、Godot、角色、数值平衡 |

**验证**：每个 agent 的典型输入正确路由

#### 6. YAML 配置文件

`config/agents/data-analysis.yaml`、`product-ops.yaml`、`financial.yaml`、`game-dev.yaml`

**验证**：YAML 格式正确

#### 7. CLI 注册

`index.ts` → agents map 追加 4 个 Agent，启动日志更新

**验证**：`npm run build` 通过

---

### P1 — Skills（28 个 SKILL.md）

| 智能体 | 数量 | 技能列表 |
|--------|:--:|------|
| data-analysis | 6 | data-cleaning、statistical-analysis、data-visualization、correlation-analysis、time-series、sql-query |
| product-ops | 6 | prd-writing、user-research、content-creation、ab-test-analysis、roadmap-planning、presentation |
| financial | 8 | stock-screening、fundamental-analysis、technical-analysis、portfolio-management、risk-assessment、market-monitor、financial-report、etf-analysis |
| game-dev | 8 | game-design-doc、level-design、character-balance、economy-design、gdscript-coding、sprite-animation、scene-architecture、playtest-analysis |

---

### P2 — 测试 & 文档

#### 8. 冒烟测试扩展

- 路由器：每个 agent 各 3 用例 = 12 用例
- Agent 配置：4 个配置加载验证
- 目标：46 → 62+

#### 9. AGENTS.md / README 更新

- 更新 Phase 2 完成状态
- 补充 agent 列表

---

## 依赖关系

```
① Data Analysis        ② Product Ops        ③ Financial         ④ Game Dev
       └──────────────────────┬──────────────────────┘
                              ↓
              ⑤ 路由规则    ⑥ YAML 配置    ⑦ CLI 注册
                              ↓
                      ⑧ 28 个 SKILL.md
                              ↓
                    ⑨ 测试扩展 + 文档更新
```

---

## 文件产出清单

```
src/agents/
  data-analysis-agent.ts              # 新增
  product-ops-agent.ts                # 新增
  financial-agent.ts                  # 新增
  game-dev-agent.ts                   # 新增
  router.ts                           # 修改（4 组关键词）
config/agents/
  data-analysis.yaml                  # 新增
  product-ops.yaml                    # 新增
  financial.yaml                      # 新增
  game-dev.yaml                       # 新增
skills/
  data-analysis/
    data-cleaning/SKILL.md            # 新增
    statistical-analysis/SKILL.md     # 新增
    data-visualization/SKILL.md       # 新增
    correlation-analysis/SKILL.md     # 新增
    time-series/SKILL.md              # 新增
    sql-query/SKILL.md                # 新增
  product-ops/
    prd-writing/SKILL.md              # 新增
    user-research/SKILL.md            # 新增
    content-creation/SKILL.md         # 新增
    ab-test-analysis/SKILL.md         # 新增
    roadmap-planning/SKILL.md         # 新增
    presentation/SKILL.md             # 新增
  financial/
    stock-screening/SKILL.md          # 新增
    fundamental-analysis/SKILL.md     # 新增
    technical-analysis/SKILL.md       # 新增
    portfolio-management/SKILL.md     # 新增
    risk-assessment/SKILL.md          # 新增
    market-monitor/SKILL.md           # 新增
    financial-report/SKILL.md         # 新增
    etf-analysis/SKILL.md             # 新增
  game-dev/
    game-design-doc/SKILL.md          # 新增
    level-design/SKILL.md             # 新增
    character-balance/SKILL.md        # 新增
    economy-design/SKILL.md           # 新增
    gdscript-coding/SKILL.md          # 新增
    sprite-animation/SKILL.md         # 新增
    scene-architecture/SKILL.md       # 新增
    playtest-analysis/SKILL.md        # 新增
src/
  index.ts                            # 修改（注册 4 Agent）
  smoke-test.ts                       # 修改（+16 测试）
AGENTS.md                             # 修改
README.md                             # 修改
```
