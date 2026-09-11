/**
 * 文档内资源 URL 解析测试（修复：Markdown 预览不显示相对路径图片）
 * 纯函数来自 web/src/lib/asset-url.ts（无 DOM 依赖，可被根 vitest 直接导入）。
 *
 * 关键契约：
 * - 本地相对路径 / 盘符绝对路径 / file:// / UNC → 改写为 /api/v1/files
 * - 外部链接（http、https、协议相对）、内联（data:、blob:）、锚点、已改写引用 → 原样保留
 * - 站点根相对（/logo.png，如 web/public 下的静态资源）→ 原样保留（不回归）
 */

import { describe, it, expect } from "vitest";
import {
  resolveDocAssetSrc,
  rewriteDocAssetUrls,
  isLocalAssetRef,
  normalizeRelPath,
  fileUriToPath,
} from "../web/src/lib/asset-url.js";

const BASE = {
  root: "project",
  docRel: "reports/AI大模型发展见解与程序员职业建议.md",
  sessionId: "s1",
  apiBase: "/api/v1",
};

describe("文档内图片路径解析（Markdown 预览）", () => {
  it("相对路径按文档所在目录解析（用户报告的场景）", () => {
    const out = resolveDocAssetSrc("assets/ai-trend-diagram.svg", BASE);
    expect(out).toBe(
      "/api/v1/files?root=project&path=" +
        encodeURIComponent("reports/assets/ai-trend-diagram.svg") +
        "&session=s1",
    );
  });

  it("./ 与 ../ 归一化；反斜杠与 query 也处理", () => {
    expect(resolveDocAssetSrc("./pic.png", BASE)).toContain(encodeURIComponent("reports/pic.png"));
    expect(resolveDocAssetSrc("../shared/pic.png", BASE)).toContain(encodeURIComponent("shared/pic.png"));
    expect(resolveDocAssetSrc("assets\\win.svg", BASE)).toContain(encodeURIComponent("reports/assets/win.svg"));
    expect(resolveDocAssetSrc("assets/x.svg?v=2", BASE)).toContain(encodeURIComponent("reports/assets/x.svg"));
  });

  it("越界 ../ 不静默夹回根内（保留 .. 交给服务端拒绝）", () => {
    expect(resolveDocAssetSrc("../../etc/passwd", BASE)).toContain(encodeURIComponent("../etc/passwd"));
    expect(normalizeRelPath("reports", "../../x.png")).toBe("../x.png");
  });

  it("本地绝对路径（Windows 盘符 / UNC / file://）交给 /files 校验", () => {
    expect(resolveDocAssetSrc("C:\\pics\\a.png", BASE)).toContain(encodeURIComponent("C:/pics/a.png"));
    expect(resolveDocAssetSrc("C:/pics/a.png", BASE)).toContain(encodeURIComponent("C:/pics/a.png"));
    expect(resolveDocAssetSrc("\\\\server\\share\\a.png", BASE)).toContain(encodeURIComponent("//server/share/a.png"));
    expect(resolveDocAssetSrc("file:///D:/pics/b.png", BASE)).toContain(encodeURIComponent("D:/pics/b.png"));
    expect(resolveDocAssetSrc("file:///tmp/b.png", BASE)).toContain(encodeURIComponent("/tmp/b.png"));
    expect(fileUriToPath("file:///D:/x/a%20b.png")).toBe("D:/x/a b.png");
  });

  it("外部链接与内联引用原样保留（回归防护）", () => {
    for (const src of [
      "https://example.com/a.png",
      "HTTPS://EXAMPLE.COM/A.PNG",
      "http://127.0.0.1:3000/logo.png",
      "//cdn.example.com/a.png",
      "data:image/png;base64,iVBORw0KGgo=",
      "blob:http://localhost/abc",
      "mailto:x@y.com",
      "#section",
      "/api/v1/files?root=project&path=x.png",
      // 仅前缀相似、并非已改写引用：按站点根相对原样保留
      "/api/v1/filesx?path=a.png",
      // 站点根相对（web/public 下的静态资源）——不能被当作本地文件系统路径
      "/logo.png",
      "/favicon.svg",
      "",
    ]) {
      expect(resolveDocAssetSrc(src, BASE)).toBe(src);
    }
  });

  it("本地引用的 #fragment 保留（SVG 片段标识），query 丢弃", () => {
    const out = resolveDocAssetSrc("icons.svg#check", BASE);
    expect(out).toContain(encodeURIComponent("reports/icons.svg"));
    expect(out.endsWith("#check")).toBe(true);
    expect(resolveDocAssetSrc("assets/x.svg?v=2#a", BASE)).toContain(encodeURIComponent("reports/assets/x.svg"));
    expect(resolveDocAssetSrc("assets/x.svg?v=2#a", BASE).endsWith("#a")).toBe(true);
  });

  it("session 根（data/docs）与无会话 id 的情形", () => {
    const out = resolveDocAssetSrc("assets/pic.svg", { root: "session", docRel: "2026/report.md" });
    expect(out).toBe("/api/v1/files?root=session&path=" + encodeURIComponent("2026/assets/pic.svg"));
    expect(out).not.toContain("session=");
    expect(resolveDocAssetSrc("a.png", { root: "weird", docRel: "x.md" })).toContain("root=session");
  });

  it("中文/空格路径正确编码", () => {
    const out = resolveDocAssetSrc("资产/趋势 图.svg", { root: "project", docRel: "报告/主文.md" });
    expect(out).toContain(encodeURIComponent("报告/资产/趋势 图.svg"));
    expect(out).toContain("%20");
  });

  it("isLocalAssetRef 判定：只有明确本地引用才改写", () => {
    expect(isLocalAssetRef("assets/a.png")).toBe(true);
    expect(isLocalAssetRef("./a.png")).toBe(true);
    expect(isLocalAssetRef("C:\\a.png")).toBe(true);
    expect(isLocalAssetRef("file:///D:/a.png")).toBe(true);
    expect(isLocalAssetRef("\\\\srv\\share\\a.png")).toBe(true);
    expect(isLocalAssetRef("https://x/a.png")).toBe(false);
    expect(isLocalAssetRef("//cdn/a.png")).toBe(false);
    expect(isLocalAssetRef("data:image/png;base64,AA")).toBe(false);
    expect(isLocalAssetRef("/logo.png")).toBe(false);
    expect(isLocalAssetRef("#x")).toBe(false);
  });

  it("rewriteDocAssetUrls：混合文档只改写本地引用，并记录 data-orig-src", () => {
    const html = [
      '<p><img src="assets/a.svg" alt="本地"></p>',
      '<p><img src="https://cdn.example.com/b.png" alt="外链"></p>',
      '<p><img src="/logo.png" alt="站点资源"></p>',
      '<p><img src="data:image/png;base64,AA" alt="内联"></p>',
      '<p><img src="C:\\pics\\c.png" alt="盘符"></p>',
      "<p>无图片</p>",
    ].join("\n");
    const out = rewriteDocAssetUrls(html, BASE);

    // 相对路径 → /files（& 在 HTML 属性中需转义），并保留原引用用于失败回退
    expect(out).toContain(`src="/api/v1/files?root=project&amp;path=${encodeURIComponent("reports/assets/a.svg")}&amp;session=s1"`);
    expect(out).toContain('data-orig-src="assets/a.svg"');
    // 盘符路径 → /files
    expect(out).toContain('data-orig-src="C:\\pics\\c.png"');
    // 外链 / 站点资源 / 内联引用逐字不变
    expect(out).toContain('<img src="https://cdn.example.com/b.png" alt="外链">');
    expect(out).toContain('<img src="/logo.png" alt="站点资源">');
    expect(out).toContain('<img src="data:image/png;base64,AA" alt="内联">');
    expect(out).not.toContain('data-orig-src="https');
    expect(out).not.toContain('data-orig-src="/logo.png"');
    // 非 img 标签不受影响
    expect(out).toContain("<p>无图片</p>");
  });

  it("rewriteDocAssetUrls：无 img 时原样返回；HTML 实体正确解码/编码", () => {
    expect(rewriteDocAssetUrls("<p>纯文本</p>", BASE)).toBe("<p>纯文本</p>");
    const out = rewriteDocAssetUrls('<img src="a&amp;b/c.png">', BASE);
    expect(out).toContain('data-orig-src="a&amp;b/c.png"');
    // 路径中的 & 先编码为 %26 再作为属性值写入
    expect(out).toContain(encodeURIComponent("a&b/c.png").replace(/&/g, "%26"));
  });
});
