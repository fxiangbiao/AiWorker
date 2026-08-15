/**
 * 示例插件（Sprint 27）
 * 展示四种能力：注册工具 / 读取 config.json / 注册 Hook / scope 注册
 * 目录名 example = 插件名；入口默认导出 setup(ctx) 或 { setup, version, description }
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { PluginContext, HookContext } from "../../../src/types.js";

export default {
  version: "0.1.0",
  description: "示例插件：now（当前时间）+ greeting（问候，读 config.json）+ 工具调用日志 Hook",
  setup(ctx: PluginContext) {
    // dataDir 可能尚未创建（异常启动/测试），日志目录自建更健壮
    mkdirSync(ctx.dataDir, { recursive: true });
    const greeting = typeof ctx.config.greeting === "string" ? ctx.config.greeting : "你好";

    // 1) 全局工具：所有专家可见（受权限模型约束，ask 模式默认拦截非只读白名单工具）
    ctx.registerTool(
      "now",
      {
        type: "function",
        function: {
          name: "now",
          description: "获取当前日期时间（format: date | time | datetime）",
          parameters: {
            type: "object",
            properties: {
              format: { type: "string", description: "date=日期, time=时间, datetime=日期时间（默认）" },
            },
          },
        },
      },
      async (args) => {
        const fmt = String(args.format ?? "datetime");
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        const content = fmt === "date" ? date : fmt === "time" ? time : `${date} ${time}`;
        return { tool_call_id: "", success: true, content };
      },
    );

    // 2) 问候工具：读 config.json 的 greeting 字段
    //    注意：全局同名工具会互相覆盖（后加载覆盖先加载），建议工具名保持唯一
    ctx.registerTool(
      "greeting",
      {
        type: "function",
        function: {
          name: "greeting",
          description: "用配置的问候语向指定 agent 打招呼",
          parameters: {
            type: "object",
            properties: {
              who: { type: "string", description: "打招呼对象（默认用当前 agentId）" },
            },
          },
        },
      },
      async (args, toolCtx) => ({
        tool_call_id: "",
        success: true,
        content: `${greeting}，${String(args.who ?? toolCtx.agentId)}！`,
      }),
    );

    // 3) 注册 Hook：每次工具调用后追加一行到 <dataDir>/plugin-example-tools.log（调试追踪）
    //    HookContext: { event, agentId, sessionId, data }；onToolCallPost 的 data = { toolName, args, result }
    //    返回 undefined / { proceed: true } = 放行；返回 { proceed: false, message } = 拦截
    //    注意：TUI 接管 stdout，Hook 内不要 console.log（会破坏界面），写文件更安全
    ctx.registerHook("onToolCallPost", async (hc: HookContext) => {
      const d = hc.data as { toolName?: string; result?: { success?: boolean; content?: string } };
      const status = d.result?.success ? "ok" : "fail";
      appendFileSync(
        resolve(ctx.dataDir, "plugin-example-tools.log"),
        `${new Date().toISOString()} ${hc.agentId} ${d.toolName ?? "?"} ${status}\n`,
        "utf-8",
      );
    });

    // 4) scope 注册示例：仅 coding 专家可见（取消注释启用）
    // ctx.registerTool("secret", { ...定义... }, handler, { scope: "coding" });
  },
};
