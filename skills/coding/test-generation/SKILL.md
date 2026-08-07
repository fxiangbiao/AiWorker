---
name: test-generation
version: "1.0"
description: "生成单元/集成测试用例，覆盖正常与异常路径"
triggers:
  - 测试|test|用例|单元测试|集成测试|测试用例|覆盖率|coverage
  - spec|assert|expect|mock|stub
expert: coding
tools_required:
  - fs_read
  - fs_write
  - terminal_exec
model_preference: coding
---

# 测试生成

## 工作流程
1. 用 `fs_read` 阅读目标源文件，理解函数签名和逻辑
2. 检查项目已有测试，确认测试框架和命名约定
3. 生成测试用例，覆盖：
   - ✅ 正常路径 (happy path)
   - ❌ 异常路径 (error handling)
   - 🔲 边界条件 (edge cases)
   - 🔀 分支覆盖 (if/else/switch)

## 当前项目测试规范
- 框架：**Vitest** (`vitest run`)
- 文件位置：`src/smoke-test.ts`（冒烟测试）
- DSL：`describe` / `it` / `expect`（vitest 标准 API）
- 运行命令：`npm test`

## 输出要求
- 用小 `it()` 块测试单一行为
- 每个 `describe` 对应一个模块/文件
- 使用 `beforeAll` 进行初始化
- 使用 `afterAll` 进行清理
- 不调用外部 API（测试应该可独立运行）
