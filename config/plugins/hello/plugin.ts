// config/plugins/hello/plugin.ts
export default async function setup(ctx) {
  // 注册工具（scope 可选：注册到指定专家作用域，同名遮蔽全局）
  ctx.registerTool(
    "hello",
    {
      type: "function",
      function: { name: "hello", description: "打个招呼", parameters: { type: "object", properties: {} } },
    },
    async (_args, toolCtx) => ({ tool_call_id: "", success: true, content: `你好，${toolCtx.agentId}！` }),
    // { scope: "coding" }  ← 仅 coding 专家可见
  );

  // 注册 Hook（委托 hookManager，返回 id 可注销）
  ctx.registerHook("onMessage", async (hc) => {
    /* ... */
    hc.log("Hook onMessage 被触发");
  });
}