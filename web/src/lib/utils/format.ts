export function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

export function basename(p: string): string {
  if (!p) return "";
  const s = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return s[s.length - 1] || p;
}

export function fmtN(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}
