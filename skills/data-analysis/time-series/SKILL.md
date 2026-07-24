---
name: time-series
version: "1.0"
triggers:
  - 时间序列
  - time series
  - 时序
  - 趋势.*分析
  - 周期性
expert: data-analysis
tools_required:
  - fs_read
  - terminal_exec
---

# 时间序列分析工作流

第一步使用 `fs_read` 加载时间序列数据，确认数据包含时间戳列和至少一个数值列。将时间列解析为 datetime 类型，设置为索引，并按时间升序排列。检查时间间隔是否均匀——如果存在缺失的时间点，先做重采样（resample）填充缺失时段，可以使用前向填充或插值法。

第二步进行时间序列分解（decomposition）：通过 `terminal_exec` 调用 `statsmodels` 的 `seasonal_decompose` 函数，将序列分解为趋势分量（trend）、季节分量（seasonal）和残差分量（residual）。观察三个分量的特征：趋势是上升还是下降、季节性周期是否明显、残差是否呈现白噪声特征。

第三步检测序列的平稳性：使用 ADF 检验（Augmented Dickey-Fuller test），若 p > 0.05 则序列不平稳，需要做差分（differencing）使其平稳。记录差分阶数 d，这是后续 ARIMA 模型的重要参数。同时绘制 ACF（自相关）和 PACF（偏自相关）图来识别 AR 和 MA 的阶数 p 和 q。

第四步根据分析目标选择建模方法：预测未来值时使用 ARIMA / SARIMA（带季节性的 ARIMA）；如果序列有趋势和季节性但不考虑随机波动，可选用 Holt-Winters 指数平滑法；对于更复杂的非线性模式，可以考虑 Prophet 或 LSTM。训练模型后，划分训练集和测试集验证预测精度，使用 MAE、RMSE、MAPE 等指标评估模型效果。

第五步输出分析结果和预测：绘制原始序列与预测值的对比图，标注置信区间。将预测的未来值以表格形式输出，包含时间点和预测值上下界。如果有明显的趋势转折或季节性模式，在结论中进行说明，帮助用户理解数据的时间演化规律。
