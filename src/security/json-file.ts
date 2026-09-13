/**
 * JSON 配置文件的原子读写（Sprint 50 / IA 重构）
 *
 * 抽出来的理由：权限配置与沙箱配置都要"读全量 → 改一处 → 原子写回"，
 * 若两处各写一份，就等于两套"保留 BOM / 行尾风格 / 权限位 / 清理遗留临时文件"的逻辑，迟早分叉。
 *
 * 写入语义：临时文件 + fsync + rename（崩溃或掉电不留下半截配置）；
 * 风格语义：默认沿用原文件的 BOM、行尾、尾换行与权限位，把 diff 噪音降到最低。
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

export interface JsonObjectSnapshot {
  data: Record<string, unknown>;
  hadBom: boolean;
  /** 原文件主导行尾（`\r\n` 或 `\n`） */
  eol: string;
  /** 原文件是否以换行结尾 */
  trailing: boolean;
  /** 原文件权限位（取不到时为 null，写入用默认 umask） */
  mode: number | null;
  mtimeMs: number;
  size: number;
}

export type JsonReadResult = ({ ok: true } & JsonObjectSnapshot) | { ok: false; reason: string };

/** 读取 JSON 对象（顶层必须是对象；BOM 与行尾风格一并带出） */
export function readJsonObject(path: string): JsonReadResult {
  let text: string;
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
    text = readFileSync(path, "utf-8");
  } catch {
    return { ok: false, reason: `文件不存在或不可读: ${path}` };
  }
  const hadBom = text.charCodeAt(0) === 0xfeff;
  let data: unknown;
  try {
    data = JSON.parse(hadBom ? text.slice(1) : text);
  } catch (err) {
    return { ok: false, reason: `不是合法 JSON: ${(err as Error).message}` };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "顶层必须是对象" };
  }
  return {
    ok: true,
    data: data as Record<string, unknown>,
    hadBom,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    trailing: /\r?\n$/.test(text),
    mode: st.mode & 0o777,
    mtimeMs: st.mtimeMs,
    size: st.size,
  };
}

/** 写入风格（缺省：无 BOM、LF、有尾换行、0644） */
export interface JsonWriteStyle {
  hadBom?: boolean;
  eol?: string;
  trailing?: boolean;
  mode?: number | null;
}

/** 按原文件风格序列化（缩进 2 空格 + 指定行尾 + 指定尾换行） */
export function serializeJson(data: Record<string, unknown>, eol: string, trailing: boolean): string {
  const body = JSON.stringify(data, null, 2).split("\n").join(eol);
  return trailing ? `${body}${eol}` : body;
}

/** 原子写入 JSON（失败时 reason 为原始错误信息，调用方自行加前缀说明是哪个文件） */
export function writeJsonAtomic(
  path: string,
  data: Record<string, unknown>,
  style: JsonWriteStyle = {},
): { ok: true } | { ok: false; reason: string } {
  const eol = style.eol ?? "\n";
  const trailing = style.trailing ?? true;
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const body = `${style.hadBom ? "\uFEFF" : ""}${serializeJson(data, eol, trailing)}`;
    const fd = openSync(tmp, "w", style.mode ?? 0o644);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (style.mode !== null && style.mode !== undefined) {
      try {
        chmodSync(tmp, style.mode);
      } catch {
        /* 权限位复制失败不影响写入结果 */
      }
    }
    renameSync(tmp, path);
    cleanStaleTemps(path);
    return { ok: true };
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
    return { ok: false, reason: (err as Error).message };
  }
}

/** 清理同目录下遗留的临时文件（上次崩溃留下），避免长期堆积 */
export function cleanStaleTemps(target: string): void {
  try {
    const dir = dirname(target);
    const prefix = `${basename(target)}.tmp-`;
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const full = resolve(dir, name);
      if (!existsSync(full)) continue;
      if (statSync(full).mtimeMs < cutoff) rmSync(full, { force: true });
    }
  } catch {
    /* 清理是尽力而为 */
  }
}
