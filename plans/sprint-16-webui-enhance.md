# Sprint 16: Web UI 增强

> 目标：利用 Web 浏览器原生能力增强 Web UI，语法高亮 + 流式性能 + 体验优化

## 优先级与任务

| 优先级 | 任务 | 说明 | 预估改动 |
|------|------|------|------|
| P0 | **代码语法高亮** | highlight.js CDN + marked.js 一行集成 | `web/index.html` +~5 lines |
| P0 | **流式性能修复** | 增量 DOM 更新替代全量 innerHTML 重建 | `web/index.html` ~30 lines 重写 |
| P0 | **thinking_start 实时指示器** | 流式思考时显示加载动画 | `web/index.html` +~10 lines |
| P1 | **工具调用 spinner 动画** | tool_call → 显示旋转 spinner，结果返回后替换 | `web/index.html` +~10 lines |
| P1 | **链接 target=_blank** | 所有链接新窗口打开 | `web/index.html` +~3 lines |
| P1 | **修复 onFileDiff SSE** | server.ts 接入 onFileDiff StreamCallback | `src/server.ts` +~3 lines |
| P2 | **Plan 按钮触发 Team 协调** | 修复 Plan 模式实际调用 team coordinator | `src/server.ts` + `web/index.html` |
| P2 | **服务端会话持久化** | GET /sessions + GET /sessions/:id | `src/server.ts` ~20 lines |

## 文件变更

- **修改** `web/index.html` — 主要改动文件
- **修改** `src/server.ts` — SSE 通道 + 新 API 端点

## 验证标准

- tsc --noEmit 零错误
- eslint src/ 零错误零警告
- npm test (vitest 92 项) 全绿
- 手动验证 Web UI: 代码块有语法高亮、流式不卡顿、工具调用有 spinner、链接新窗口打开
