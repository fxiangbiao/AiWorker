---
name: file-organization
version: "1.0"
triggers:
  - 创建文件|写文件|保存|输出到|整理.*文件|组织.*目录
  - write.*file|save|output.*file|organize
expert: common
tools_required:
  - fs_write
  - fs_read
  - fs_list
---

# 文件整理与输出

## 工作流程
1. 使用 `fs_list` 了解当前目录结构
2. 根据内容类型选择合适的子目录
3. 使用 `fs_write` 创建文件（自动创建父目录）

## 建议的目录结构
- `reports/` — 研究报告
- `output/` — 代码输出
- `docs/` — 文档

## 注意事项
- 写入前检查是否已有同名文件
- 大文件分段写入
- 路径使用相对工作目录
