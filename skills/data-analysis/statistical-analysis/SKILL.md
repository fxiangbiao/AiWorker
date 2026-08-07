---
name: statistical-analysis
version: "1.0"
description: "描述性与推断性统计分析"
triggers:
  - 统计
  - statistics
  - 描述性
  - descriptive
  - 分布
  - 均值
  - 方差
expert: data-analysis
tools_required:
  - fs_read
  - terminal_exec
---

# 统计分析工作流

第一步使用 `fs_read` 加载已清洗的数据文件，确认数据准备好进入分析阶段。浏览列名和数据类型，确定哪些是数值列、哪些是分类列，以便选择合适的统计方法。

第二步执行描述性统计（descriptive statistics）：对每个数值列计算样本量、均值（mean）、中位数（median）、标准差（std）、最小值、最大值、四分位数（Q1, Q3）。对分类列计算频数分布和比例。通过 `terminal_exec` 运行 Python 脚本或 CLI 统计工具，输出汇总表格，确保统计量一目了然。

第三步分析数据分布特征：计算偏度（skewness）和峰度（kurtosis），判断数据是否近似正态分布。对于偏态严重的数据，考虑是否需要做对数变换或 Box-Cox 变换。使用 Shapiro-Wilk 或 Kolmogorov-Smirnov 检验评估正态性，并将检验结果记录在分析报告中。

第四步按分组维度做细分统计：如果有分类变量（如地区、部门、时间段），对每个分组分别计算描述性统计量，生成分组汇总表。比较各组之间的差异，标注差异较大的组别，为后续假设检验或方差分析提供线索。

第五步如果场景涉及推断统计（inferential statistics），根据需要执行 t 检验（两组比较）、ANOVA（多组比较）或卡方检验（分类变量关联）。设置显著性水平 α = 0.05，报告 p 值和置信区间。最终将所有统计结果整理为结构化摘要，输出到终端或保存到文件。
