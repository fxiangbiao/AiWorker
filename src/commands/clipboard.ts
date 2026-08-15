/**
 * 剪贴板工具 — 从 index.ts 迁出（/copy 命令使用）
 */

import { spawn } from "node:child_process";

/** 复制文本到系统剪贴板（Windows: clip.exe, macOS: pbcopy, Linux: xclip） */
export async function copyToClipboard(text: string): Promise<void> {
  const platform = process.platform;
  const cmd = platform === "win32" ? "clip" : platform === "darwin" ? "pbcopy" : "xclip";
  const args = platform === "linux" ? ["-selection", "clipboard"] : [];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { shell: platform === "win32" });
    let err = "";
    child.on("error", (e) => {
      err = e.message;
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err || `clipboard command failed (code ${code})`));
    });
    child.stdin.write(text);
    child.stdin.end();
  });
}
