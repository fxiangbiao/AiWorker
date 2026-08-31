import { marked } from "marked";
import hljs from "highlight.js";
import DOMPurify from "dompurify";

marked.setOptions({
  breaks: true,
  gfm: true,
});

// marked v15 移除了 highlight 选项：改用 renderer 扩展做代码高亮（同步返回，保持渲染行为不变）
marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }): string {
      const language = lang || "plaintext";
      let html: string;
      try {
        html = hljs.highlight(text, { language }).value;
      } catch {
        const d = document.createElement("div");
        d.textContent = text;
        html = d.innerHTML;
      }
      const cls = language !== "plaintext" ? ` class="hljs language-${language}"` : "";
      return `<pre><code${cls}>${html}</code></pre>`;
    },
  },
});

export function renderMarkdown(text: string): string {
  try {
    const html = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(html.replace(/<a /g, '<a target="_blank" rel="noopener" '));
  } catch {
    const d = document.createElement("div");
    d.textContent = text;
    return d.innerHTML;
  }
}
