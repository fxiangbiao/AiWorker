/**
 * 最简插件示例
 * 目录名 hello = 插件名；入口默认导出 setup(ctx) 或 { setup, version, description }
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { PluginContext, HookContext } from "../../../src/types.js";

export default async function setup(ctx: PluginContext) {
  // 日志目录自建更健壮（dataDir/logs/plugin 可能尚未创建）
  mkdirSync(resolve(ctx.dataDir, "logs/plugin"), { recursive: true });

  // 1) 注册工具（scope 可选：注册到指定专家作用域，同名遮蔽全局）
  ctx.registerTool(
    "hello",
    {
      type: "function",
      function: { name: "hello", description: "打个招呼", parameters: { type: "object", properties: {} } },
    },
    async (_args, toolCtx) => ({ tool_call_id: "", success: true, content: `你好，${toolCtx.agentId}！` }),
    // { scope: "coding" }  ← 仅 coding 专家可见
  );

  // 2) 注册 Hook：onMessage 每次用户消息触发，data = { instruction, mode }
  //    返回 undefined / { proceed: true } = 放行；{ proceed: false, message } = 拦截
  //    注意：HookContext 没有 log 方法；TUI 接管 stdout，console.log 会破坏界面，写文件更安全
  ctx.registerHook("onMessage", async (hc: HookContext) => {
    const data = hc.data as { instruction?: string };
    appendFileSync(resolve(ctx.dataDir, "logs/plugin/hello-messages.log"), `${new Date().toISOString()} ${data.instruction}\n`, "utf-8");
  });
}
