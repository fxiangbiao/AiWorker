/**
 * 示例插件（Sprint 27）
 * 展示三种能力：注册工具 / 读取 config.json / scope 注册
 * 目录名 example = 插件名；入口默认导出 setup(ctx) 或 { setup, version, description }
 */
import type { PluginContext } from "../../../src/types.js";

export default {
  version: "0.1.0",
  description: "示例插件：now（当前时间）+ hello（问候，读 config.json）",
  setup(ctx: PluginContext) {
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

    // 3) scope 注册示例：仅 coding 专家可见（取消注释启用）
    // ctx.registerTool("secret", { ...定义... }, handler, { scope: "coding" });
  },
};
