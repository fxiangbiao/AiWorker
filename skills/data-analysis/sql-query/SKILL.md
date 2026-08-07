---
name: sql-query
version: "1.0"
description: "SQL 查询编写与执行，连接数据库取数"
triggers:
  - SQL
  - sql
  - 数据库
  - 查询
  - SELECT
  - JOIN
  - GROUP BY
expert: data-analysis
tools_required:
  - terminal_exec
---

# SQL 查询工作流

首先确认用户的数据库连接信息：数据库类型（MySQL、PostgreSQL、SQLite 等）、连接地址、端口、用户名和凭证。如果用户提供了连接字符串，通过 `terminal_exec` 使用对应的命令行客户端测试连接是否可达，确认版本信息。

第二步理解查询需求：明确用户想从哪些表中提取什么数据，涉及的筛选条件、聚合维度和排序规则。在编写 SQL 之前，先用自然语言将查询逻辑复述一遍跟用户确认，避免理解偏差导致反复修改。对于复杂查询，先画一个简单的逻辑流程图：需要 JOIN 哪些表，以哪个表为主表，JOIN 条件是什么。

第三步编写和优化 SQL 语句：使用 `terminal_exec` 执行 EXPLAIN 或 EXPLAIN ANALYZE 查看查询计划，检查是否存在全表扫描。合理使用索引（确保 WHERE、JOIN、ORDER BY 涉及的列有索引），避免在 WHERE 子句中对列使用函数导致索引失效。对于大数据量查询，添加 LIMIT 做分页或采样，先在少量数据上验证逻辑正确性。

第四步处理查询结果：将查询结果导出为 CSV 或 JSON 格式保存到文件，方便后续分析使用。如果是聚合查询，检查汇总结果是否符合预期（如行数、总和）。对于多表 JOIN 的结果，验证行数变化是否合理——一对多 JOIN 后行数不会少于主表行数，若有缺失说明 JOIN 条件可能不正确。

第五步如果涉及写操作（INSERT、UPDATE、DELETE），务必先在事务中执行，查询验证后再 COMMIT。对生产环境的数据修改操作，先执行 SELECT 确认影响范围。建议在 WHERE 条件中先用子查询或临时表筛选出目标记录，确认无误后再执行变更。始终保持备份意识，重要操作前先导出受影响的数据。
