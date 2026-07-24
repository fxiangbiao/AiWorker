/**
 * 专家路由器 — 两阶段路由
 * 阶段 1: 关键词正则快速匹配
 * 阶段 2: LLM 语义判断兜底
 */

import type { ModelRouter } from "../core/model-router.js";
import type { Message } from "../types.js";

interface RouteRule {
  agentId: string;
  keywords: RegExp[];
  weight: number;
}

const rules: RouteRule[] = [
  {
    agentId: "coding",
    keywords: [
      /编写|开发|实现|写代码|创建.*函数|新建.*组件|添加.*功能|修改.*代码/i,
      /修复|调试|debug|bug|报错|解决.*错误|排错|排查/i,
      /重构|refactor|优化.*代码|改进.*代码|简化/i,
      /测试|test|用例|单元测试|集成测试|测试用例|覆盖率/i,
      /编译|build|运行.*项目|启动.*项目|部署|deploy/i,
      /code|develop|fix|implement|refactor|optimize|compile/i,
      /function|component|module|class.*create|interface.*add/i,
      /git|commit|branch|merge|pull.*request|push/i,
      /npm|yarn|pnpm|package\.json|安装.*依赖|依赖.*安装/i,
      /TypeScript|JavaScript|TS|JS|typescript|javascript/,
    ],
    weight: 90,
  },
  {
    agentId: "research",
    keywords: [
      /研究|调研|分析|报告|对比|比较|趋势|预测|行业|市场|竞品|综述|白皮书|论文|调查|评估/i,
      /research|analysis|report|compare|trend|forecast|survey|review|evaluate/i,
      /vs\.?|versus|对决|对比|测评/,
      /优点|缺点|优劣势|利弊|优劣/i,
      /有没有.*对比|帮我.*分析|帮我.*研究|帮我.*查/,
    ],
    weight: 80,
  },
  {
    agentId: "default",
    keywords: [/.*/],
    weight: 0,
  },
];

export function routeToExpert(input: string): string {
  let bestScore = 0;
  let bestAgent = "default";

  for (const rule of rules) {
    for (const keyword of rule.keywords) {
      if (keyword.test(input)) {
        if (rule.weight > bestScore) {
          bestScore = rule.weight;
          bestAgent = rule.agentId;
        }
        break;
      }
    }
  }

  return bestAgent;
}

export async function routeToExpertLLM(
  input: string,
  modelRouter: ModelRouter
): Promise<string> {
  const prompt: Message[] = [
    {
      role: "system",
      content: `你是一个任务路由器。根据用户输入判断应该分配给哪个专家智能体。

可选的智能体：
- coding: 编码工程师 — 编写代码、调试、重构、测试、编译部署
- research: 研究分析师 — 研究、调研、对比分析、趋势预测、报告生成
- default: 通用助手 — 文件操作、终端命令、日常问答

只回复智能体 ID（如 "coding"、"research" 或 "default"），不要回复其他内容。`,
    },
    {
      role: "user",
      content: input,
    },
  ];

  try {
    const response = await modelRouter.completeWithProfile("lite", prompt);
    const agentId = response.text.trim().toLowerCase();
    if (["coding", "research", "default"].includes(agentId)) {
      return agentId;
    }
    return "default";
  } catch {
    return "default";
  }
}

export async function smartRoute(
  input: string,
  modelRouter?: ModelRouter
): Promise<string> {
  const fastResult = routeToExpert(input);
  if (fastResult !== "default") {
    return fastResult;
  }

  if (modelRouter) {
    return routeToExpertLLM(input, modelRouter);
  }

  return "default";
}
