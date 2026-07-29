# Sprint 8: 记忆系统增强 — FTS5 跨会话检索 + 有界记忆优化

---

## 一、动机

- FTS5 `unicode61` tokenizer 按字符拆分中文，**词级语义丢失**
- 情景记忆检索**无时间衰减**，旧内容和最新会话权重相同
- MEMORY.md 每次直接覆盖写入，**项目上下文被会话摘要冲刷**
- USER.md **从未自动更新**
- `KEEP_RECENT = 6` 硬编码，不随会话长度自适应

---

## 二、FTS5 中文分词

### 方案选择

| 方案 | 依赖 | 分词质量 | 选型 |
|------|------|---------|------|
| 2-gram | 零 | 差 — "数据分析" → "数据 据分 分析" | ❌ |
| jieba-js | npm 包 | 好 | ❌ 额外依赖 |
| **Intl.Segmenter** | Node 22 内置 | 好 — ICU 词法分割 | ✅ |
| nodejieba | 需编译 | 最好 | ❌ 过重 |

### 实现

```typescript
const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });

function segmentChinese(text: string): string {
  return [...segmenter.segment(text)]
    .filter(s => s.isWordLike)
    .map(s => s.segment)
    .join(" ");
}
// "数据分析是最好的工具" → "数据分析 是 最好 的 工具"
```

**存储时** — 将分词结果追加到 content 末尾，供 FTS5 索引（`unicode61` 会按空格拆分为独立 token）：

```typescript
saveEpisodic(sessionId, content, summary, weight = 1.0) {
  const enriched = content + (segments ? ' ' + segments : '');
  stmt.run(sessionId, enriched, summary, Date.now(), weight);
}
```

**查询时** — 先原始 FTS5 MATCH → 无结果则分词 MATCH → LIKE 兜底：

```
searchEpisodic(query):
  1. MATCH query           → 命中则返回
  2. MATCH segment(query)  → 命中则返回
  3. LIKE '%query%'        → 兜底
```

### 时间衰减

```
decayFactor = max(0.1, 1 − daysAgo × 0.15)
```

每天衰减 15%，6 天后降至最低 10%，7 天后 < 0.1 自动过滤。

---

## 三、有界记忆优化

### 3.1 MEMORY.md 结构化分段

**问题**: 当前直接覆盖写入，会话摘要冲刷永久项目知识。

**方案**: 分两段存储，互不干扰

```markdown
# Agent 记忆
> 上次更新: 2026-07-29

## 项目信息 （≤ 40%，固定上下文，手动/系统写入）
- 这是 React 18 + TypeScript 项目
- 使用 Vitest 做测试

## 会话历史 （≤ 60%，自动滚动，最近优先）
- [07-29] 实现了 Team Coordinator
- [07-28] 补齐了 5 个 Hook
```

- `updateMemory()` → 写入或合并到 **项目信息** 段
- `summarizeSession()` → 追加到 **会话历史** 段（写入文件前解析 → 插入新条目 → 截断各段 → 写回）

### 3.2 自适应 KEEP_RECENT

```
KEEP_RECENT = max(4, min(20, ceil(conversation.length × 0.2)))
```

| 总消息数 | 旧方案(固定6) | 新方案 | 
|---------|-------------|--------|
| 10 | 6 | 4 |
| 50 | 6 | 10 |
| 100 | 6 | 20 |

上下界约束（4~20），短会话少保留避免空摘要，长会话多保留避免丢关键上下文。

### 3.3 USER.md 自动更新

规则提取用户偏好，不依赖 LLM：
- `"我习惯用 React"` → 加入技术栈偏好
- `"先写测试"` → 加入工作习惯
- `"用中文回复"` → 加入风格偏好

调用点：`summarizeSession()` 中额外执行一次 `updateUserProfile()`。

---

## 四、修改文件

| 文件 | 变更 |
|------|------|
| `src/memory/session-store.ts` | `Intl.Segmenter` 分词 + 三阶段查询 + 时间衰减排序 |
| `src/types.ts` | `EpisodicEntry` 增加 `decayFactor` |
| `src/memory/compressor.ts` | 自适应 `KEEP_RECENT` |
| `src/core/context-manager.ts` | MEMORY.md 双段结构 + USER.md 自动更新 |

---

## 五、测试计划

| 测试 | 说明 |
|------|------|
| `segmentChinese` 分词正确 | "数据分析" → "数据分析" |
| `searchEpisodic` 中文分词命中 | 存 "数据分析方法"，搜 "数据分析" 命中 |
| 时间衰减计算 | 0 天 → 1.0, 4 天 → 0.4, 7 天 → 被过滤 |
| 衰减排序 | 新条目排在旧条目前面 |
| 自适应 KEEP_RECENT | 10 条 → 4, 50 条 → 10, 100 条 → 20 |
| MEMORY.md 双段持久 | 项目信息段不受会话历史段冲刷 |
| USER.md 自动更新 | 对话后包含提取的技术栈/习惯 |
