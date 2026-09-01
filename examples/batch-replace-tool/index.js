/**
 * 批量替换工具（示例应用）— 通过能力桥 fs 在沙箱内批量替换文本
 * 入口契约：默认导出 handler(name, args, ctx)；返回 {ok, ...} 结构由工具调用方透传
 */
export default async function handleTool(name, args, ctx) {
  const { files = [], from, to } = args || {};
  if (!Array.isArray(files) || files.length === 0) return { ok: false, error: "files 不能为空" };
  if (typeof from !== "string" || from.length === 0) return { ok: false, error: "from 不能为空" };
  const replaceTo = typeof to === "string" ? to : "";

  const changed = [];
  const skipped = [];
  for (const rel of files) {
    try {
      const content = await ctx.fs.read(rel);
      if (typeof content !== "string") {
        skipped.push({ file: rel, reason: "非文本内容" });
        continue;
      }
      if (!content.includes(from)) {
        skipped.push({ file: rel, reason: "未包含目标文本" });
        continue;
      }
      const next = content.split(from).join(replaceTo);
      await ctx.fs.write(rel, next);
      changed.push({ file: rel, replacements: content.split(from).length - 1 });
    } catch (err) {
      skipped.push({ file: rel, reason: (err && err.message) || String(err) });
    }
  }
  return { ok: true, changed, skipped };
}
