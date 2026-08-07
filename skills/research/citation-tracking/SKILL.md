---
name: citation-tracking
version: "1.0"
description: "引用来源追踪与可信度评估"
triggers:
  - 引用|来源|参考文献|参考|citation|reference
expert: research
tools_required:
  - web_search
  - web_fetch
model_preference: reasoning
---

# 引用追踪与来源管理

## 工作流程
1. 收集所有引用来源，记录：
   - URL
   - 标题
   - 作者/发布方
   - 发布日期
   - 访问日期
2. 来源可信度评估：
   - 🟢 高可信：官方文档、权威论文、知名媒体
   - 🟡 中可信：技术博客、行业报告、经验分享
   - 🔴 低可信：个人观点、匿名来源、营销内容
3. 交叉验证：同一信息点至少 2 个独立来源确认

## 输出格式
每次引用使用脚注风格：
```
[1] OpenAI官方文档, https://platform.openai.com/docs, 2024-01
[2] 社区评测文章, https://example.com, 2024-02
```

## 使用方式
- 在分析过程中随时追加引用
- 最终输出时汇总为完整来源列表
- 无法验证的信息必须标注"未核实"
