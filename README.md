# AiWorker

> 个人 AI Agent 助手 — 多智能体协作 + MCP + Skills + Hooks

## 当前状态：Phase 1 MVP ✅

Phase 1 核心引擎已实现，包含：

- ✅ **Agent 循环**：同步循环 + 迭代预算 + 工具并行执行 + 92% 压缩
- ✅ **模型路由**：OpenAI 兼容格式，多 profile 路由 (coding/reasoning/writing/creative/lite)
- ✅ **工具注册表**：单例模式 + 运行时可用性检查 + 动态 Schema
- ✅ **上下文管理**：三层记忆 (工作/情景/语义) + 冻结快照 + FTS5 检索 + 有界设计
- ✅ **内置工具**：fs_read / fs_write / fs_list / terminal_exec / web_search / web_fetch
- ✅ **安全层**：Ask/Plan/Craft 三模式 + 危险操作正则拦截 + 审计日志
- ✅ **Hooks 系统**：5 生命周期点 (onMessage/onToolCallPre/onToolCallPost/onTaskComplete/onError)
- ✅ **CLI 入口**：交互式终端，支持 /mode 切换

## 快速开始

```bash
# 设置 API Key
export OPENAI_API_KEY=sk-...

# 启动
npm run dev

# 或编译后运行
npm run build
npm start

# 指定工作目录和模式
npm start -- --dir /path/to/project --mode craft
```

### 权限模式

| 模式 | 说明 | 工具调用 |
|------|------|---------|
| ask | 纯问答 | ❌ |
| plan | 先列计划，确认后执行 | ❌ (需确认) |
| craft | 自主执行，高危仍需确认 | ✅ |

## 项目结构

```
aiworker/
├── config/           # 配置文件
│   ├── models.json   # 模型路由配置
│   ├── mcp.json      # MCP 连接器配置
│   └── permissions.json
├── src/
│   ├── core/         # 核心引擎
│   │   ├── agent-loop.ts       # Agent 循环 (系统心脏)
│   │   ├── context-manager.ts  # 上下文管理 (组装/压缩)
│   │   ├── model-router.ts     # 模型路由器
│   │   ├── tool-registry.ts    # 工具注册表 (单例)
│   │   └── audit-logger.ts     # 审计日志
│   ├── agents/       # 智能体
│   │   ├── base-agent.ts       # 基类
│   │   └── default-agent.ts    # 默认通用智能体
│   ├── memory/       # 记忆系统
│   │   ├── session-store.ts    # SQLite + FTS5
│   │   └── compressor.ts       # 92% 压缩
│   ├── tools/        # 内置工具
│   │   └── builtin.ts
│   ├── hooks/        # Hooks 系统
│   │   └── hook-manager.ts
│   ├── security/     # 安全层
│   │   ├── permission-model.ts # 三模式权限
│   │   ├── danger-detector.ts  # 危险检测
│   │   └── audit-log.ts        # 审计日志
│   ├── types.ts      # 核心类型定义
│   └── index.ts      # CLI 入口
├── data/             # 运行时数据 (gitignore)
├── package.json
└── tsconfig.json
```

## 冒烟测试

```bash
npm test
```

39 项测试覆盖：工具注册、危险检测、权限模型、会话存储、FTS5 检索、上下文压缩、Hooks 拦截、工具执行。

## 后续阶段

| 阶段 | 内容 | 状态 |
|------|------|------|
| Phase 1 | 核心引擎 MVP | ✅ 完成 |
| Phase 2 | 六大专家智能体 + Skills | 待开发 |
| Phase 3 | 多智能体协作 + 长期记忆 | 待开发 |
| Phase 4 | 自进化 + 生态 | 待开发 |

## 技术栈

- **语言**: TypeScript 5.x + Node.js 22.x
- **存储**: SQLite + WAL + FTS5
- **模型**: OpenAI 兼容格式 (支持任意兼容 provider)
- **CLI**: Commander.js + Inquirer
- **设计依据**: 《个人AI-Agent助手设计方案.md》
