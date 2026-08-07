---
name: data-visualization
version: "1.0"
description: "数据可视化：图表选型与生成"
triggers:
  - 可视化
  - visualization
  - 图表
  - chart
  - plot
  - 直方图
  - 折线图
expert: data-analysis
tools_required:
  - fs_write
  - terminal_exec
---

# 数据可视化工作流

首先明确可视化的目标和受众：是为了探索性数据分析（EDA）、向管理层汇报，还是嵌入到分析报告中。根据目标选择合适的图表类型——分布用直方图或箱线图，趋势用折线图，对比用柱状图，占比用饼图，关系用散点图。

确定图表类型后，通过 `terminal_exec` 使用 Python 的可视化库（matplotlib、seaborn、plotly 等）编写绘图脚本。设置合适的画布尺寸（figure size）、分辨率（dpi），确保文字标签清晰可读。为图表添加标题、坐标轴标签、图例，必要时添加数据标注（annotation）突出关键信息点。

颜色方案的选择要兼顾美观与可访问性：避免使用红绿色搭配（色盲友好），优先使用调色板（如 seaborn 的 colorblind 或 viridis）。分类数据使用离散调色板，连续数据使用渐变调色板。保持同一分析项目中多个图表的颜色映射一致。

多子图（subplots）布局时，使用 `plt.subplots` 统一管理行列布局，确保各子图的坐标轴范围合理，避免信息密度过高。如需展示多维数据关系，考虑使用散点矩阵（pairplot）、热力图（heatmap）或平行坐标图。

图表生成后，使用 `fs_write` 将图表保存为 PNG 或 SVG 文件，PNG 适合嵌入文档，SVG 适合矢量编辑。建议文件命名包含图表类型和数据说明，如 `sales_trend_lineplot.png`。检查导出的图表是否清晰完整，确认没有截断或重叠问题。若需交互式图表，可导出为 HTML 文件（使用 plotly）。
