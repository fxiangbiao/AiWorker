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
    agentId: "data-analysis",
    keywords: [
      /数据分析|统计.*分析|数据.*清洗|数据.*挖掘|数据.*探索/i,
      /可视化|图表|chart|plot|直方图|折线图|柱状图|散点图|饼图/i,
      /pandas|numpy|matplotlib|scipy|scikit.*learn|jupyter/i,
      /SQL|sql|数据库.*查询|query.*data|数据集|dataset|csv|excel/i,
      /相关性|回归|分类|聚类|预测.*模型|时间序列|time.*series/i,
      /data.*analysis|statistics|visualization|correlation|regression/i,
    ],
    weight: 70,
  },
  {
    agentId: "financial",
    keywords: [
      /股票|基金|投资|理财|估值|选股|炒股|A股|港股|美股/i,
      /K线|k线|MACD|KDJ|RSI|布林带|均线|成交量|换手率/i,
      /PE|PB|ROE|市盈率|市净率|净资产.*收益率|股息/i,
      /财报|年报|季报|营收|净利润|毛利率|现金流|负债/i,
      /ETF|指数.*基金|板块|行业.*分析|龙头/i,
      /stock|fund|invest|portfolio|dividend|financial.*report|market.*analysis/i,
      /止损|止盈|仓位|持仓|定投|波动|风险.*控制/i,
    ],
    weight: 85,
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
    agentId: "game-dev",
    keywords: [
      /游戏.*设计|游戏.*开发|设计.*游戏|开发.*游戏|制作.*游戏/i,
      /Godot|godot|GDScript|gdscript|游戏.*引擎/i,
      /关卡.*设计|level.*design|角色.*设计|角色.*平衡|数值.*平衡/i,
      /像素|动画|sprite|tilemap|2D|游戏.*场景|游戏.*UI/i,
      /RPG|FPS|平台|横版|塔防|卡牌|roguelike|游戏.*机制|玩法/i,
      /game.*design|game.*dev|game.*development|balance.*design/i,
    ],
    weight: 65,
  },
  {
    agentId: "product-ops",
    keywords: [
      /PRD|产品.*需求|需求.*文档|产品.*规划|产品.*设计|产品.*方案/i,
      /用户.*调研|用户.*访谈|用户.*画像|用户.*体验|UX|可用性/i,
      /运营.*方案|运营.*策略|内容.*创作|内容.*营销|文案/i,
      /A\/B.*测试|AB.*test|转化率|留存|漏斗|DAU|MAU|KPI|OKR/i,
      /路标|roadmap|排期|迭代.*计划|sprint.*plan/i,
      /产品.*运营|product.*manager|product.*owner|product.*ops/i,
    ],
    weight: 60,
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
- data-analysis: 数据分析师 — 数据分析、统计、可视化、SQL
- financial: 理财投资顾问 — 股票、基金、投资分析（默认 ask 模式）
- research: 研究分析师 — 研究、调研、对比分析、趋势预测、报告生成
- game-dev: 游戏设计师 — 游戏设计、Godot、GDScript、关卡设计
- product-ops: 产品运营 — PRD、用户调研、内容创作、运营方案
- default: 通用助手 — 文件操作、终端命令、日常问答

只回复智能体 ID（如 "coding"），不要回复其他内容。`,
    },
    {
      role: "user",
      content: input,
    },
  ];

  try {
    const response = await modelRouter.completeWithProfile("lite", prompt);
    const agentId = response.text.trim().toLowerCase();
    if (["coding", "data-analysis", "financial", "research", "game-dev", "product-ops", "default"].includes(agentId)) {
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
