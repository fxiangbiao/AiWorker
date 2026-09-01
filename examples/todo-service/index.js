/**
 * 待办清单服务（示例应用）— 常驻子进程，能力桥 storage 持久化
 * 工具调用：{ action: "add", text } 添加；{ action: "list" } 列出；{ action: "done", index } 完成
 */
const KEY = "todos";

async function list(ctx) {
  const raw = await ctx.storage.get(KEY);
  return Array.isArray(raw) ? raw : [];
}

export default async function handleTool(name, args, ctx) {
  const { action } = args || {};
  if (action === "add") {
    if (typeof args?.text !== "string" || !args.text.trim()) return { ok: false, error: "text 不能为空" };
    const todos = await list(ctx);
    todos.push({ text: args.text.trim(), done: false, at: Date.now() });
    await ctx.storage.set(KEY, todos);
    return { ok: true, count: todos.length };
  }
  if (action === "list") {
    return { ok: true, todos: await list(ctx) };
  }
  if (action === "done") {
    const todos = await list(ctx);
    const idx = Number(args?.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= todos.length) return { ok: false, error: "index 越界" };
    todos[idx].done = true;
    await ctx.storage.set(KEY, todos);
    return { ok: true, count: todos.length };
  }
  return { ok: false, error: `未知 action: ${action}（add|list|done）` };
}
