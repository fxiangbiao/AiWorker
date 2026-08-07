---
name: web-deep-search
version: "1.0"
description: "多轮 Web 深度搜索与信息汇总"
triggers:
  - 搜索|查找|检索|查询|资料|查一下|了解一下
  - search|lookup|find.*info
expert: research
tools_required:
  - web_search
  - web_fetch
model_preference: reasoning
---

# Web 深度搜索

## 工作流程
1. 分析用户查询意图，提取核心关键词和多角度搜索词
2. 使用 `web_search` 搜索：先搜索主关键词，再搜索补充角度
3. 对高质量结果使用 `web_fetch` 抓取完整页面内容
4. 交叉验证：多个来源确认同一信息后，标记为"已验证"
5. 整理搜索结果，按相关度排序，标注来源 URL

## 搜索策略
- 主关键词：直接搜索用户提出的核心问题
- 补充关键词：拆解为子问题，分别搜索
- 反方观点：主动搜索反对意见，保证客观性
- 时间限定：优先最近 1-2 年的信息

## 输出格式
- 总搜索次数 + 抓取页面数
- 关键发现（3-5 条）
- 待验证信息
- 完整来源列表
