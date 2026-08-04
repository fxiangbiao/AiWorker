import { marked } from "marked";
import hljs from "highlight.js";
import DOMPurify from "dompurify";

marked.setOptions({
  breaks: true,
  gfm: true,
  highlight: (code: string, lang: string) => {
    try {
      return hljs.highlight(code, { language: lang || "plaintext" }).value;
    } catch {
      const d = document.createElement("div");
      d.textContent = code;
      return d.innerHTML;
    }
  },
});

export function renderMarkdown(text: string): string {
  try {
    return DOMPurify.sanitize(
      marked.parse(text).replace(/<a /g, '<a target="_blank" rel="noopener" ')
    );
  } catch {
    const d = document.createElement("div");
    d.textContent = text;
    return d.innerHTML;
  }
}
