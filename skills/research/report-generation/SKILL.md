---
name: report-generation
version: "1.0"
description: "结构化研究报告生成"
triggers:
  - 报告|report|总结|summary|整理|汇总|输出
expert: research
tools_required:
  - web_search
  - fs_write
model_preference: reasoning
---

# 研究报告生成

## 报告结构
1. **摘要** (Executive Summary)
   - 3-5 条核心发现
   - 一句话结论
2. **背景与方法**
   - 研究目的与范围
   - 信息来源和搜索策略
3. **详细分析**
   - 按主题/维度分层展开
   - 关键数据引用
4. **对比矩阵**（如有多个对比对象）
5. **结论与建议**
   - 可操作的下一步建议
6. **参考来源**
   - 每个来源标注 URL + 访问日期

## 输出渠道
- 终端输出：精简版（摘要 + 关键结论）
- 文件输出：使用 `fs_write` 保存完整版 Markdown 报告
  - 文件命名：`reports/{主题}-{日期}.md`
  - 自动创建 `reports/` 目录

## 质量检查
- [ ] 每个关键结论有来源支撑
- [ ] 区分事实、分析和观点
- [ ] 不遗漏重要反方观点
- [ ] 格式清晰，可快速扫描
