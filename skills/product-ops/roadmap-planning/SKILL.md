---
name: roadmap-planning
version: "1.0"
triggers:
  - 路标|roadmap|排期|迭代.*计划|规划|里程碑
expert: product-ops
tools_required:
  - fs_write
---

# 路线图与迭代规划

## 工作流程
1. 明确产品愿景与阶段目标：对齐公司战略，确定 3-6 个月的阶段焦点
2. 梳理需求池：收集来自用户反馈、业务方、竞品分析的各类需求，按 RICE（Reach × Impact × Confidence ÷ Effort）打分
3. 绘制 time-based roadmap：按月度/双周划分时间窗口，每个窗口确定 1 个主题目标和 3-5 个关键交付
4. 制定迭代计划：将 roadmap 拆解为具体迭代（Sprint），每期迭代明确范围、交付物和验收标准
5. 识别里程碑节点：标注关键交付日期、外部依赖节点、风险缓冲期
6. 使用 `fs_write` 输出 roadmap 到 `roadmap-{产品}-{年份}Q{季度}.md`

## 优先级评估方法
- RICE 打分法：Reach（影响用户数）× Impact（对指标的提升）÷ 1（高）/ 50%（中）/ 20%（低）Confidence ÷ Effort（人天）
- MoSCoW 分类：Must have / Should have / Could have / Won't have（当前版本）
- Kano 模型补充：基本型需求必须满足，兴奋型需求作为差异化亮点

## 输出格式
- 产品愿景（一句话）
- 季度目标与成功指标
- 时间线总览（按月度或双周的甘特图文字版）
- 各迭代详情：主题、范围、交付物、依赖、风险
- 里程碑日历表
- 资源评估（所需人力、技术栈、外部依赖）
- 风险登记表（风险描述、概率、影响、缓解措施、负责人）
