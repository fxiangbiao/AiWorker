---
name: debug
version: "1.0"
description: "复现并定位 bug，分析根因后修复"
triggers:
  - 调试|debug|报错|bug|错误|异常|修复|fix|解决.*问题|问题.*解决
  - troubleshoot|crash|fail|error|broken
expert: coding
tools_required:
  - fs_read
  - terminal_exec
model_preference: coding
---

# 调试排错

## 工作流程
1. **复现**：用 `terminal_exec` 运行命令复现错误
2. **定位**：读取错误堆栈，用 `fs_read` 查看相关源文件
3. **分析根因**：不是修表象，而是找 root cause
4. **修复**：最小改动解决问题
5. **验证**：运行测试确认修复有效且不引入新问题

## 常见错误模式速查
| 错误类型 | 常见原因 | 排查方法 |
|---------|---------|---------|
| TypeError/undefined | 空值访问 | 检查数据来源、默认值 |
| Import error | 路径/扩展名 | 检查 .js 扩展名、相对路径 |
| Build failed | 类型错误 | 运行 tsc --noEmit |
| Runtime crash | 未处理异常 | 查看堆栈顶层 |
| Permission denied | 权限模式 | 检查当前 ask/plan/craft 模式 |

## 排查技巧
- 二分法注释排查：注释掉一半代码确认问题范围
- 添加临时 console.log 观察变量值
- 检查 git diff 看最近改动
- 阅读依赖的源码（node_modules 内）
