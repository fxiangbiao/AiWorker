#!/usr/bin/env node
/**
 * .aw 包打包工具 — 把插件/技能目录打包为 .aw（zip）分发文件
 * 用法:
 *   node scripts/pack-aw.mjs <源目录> [-o 输出路径] [--name 覆盖名] [--version 覆盖版本]
 * 要求: 源目录含 manifest.json（type: plugin|skill）
 * 输出: <源目录名>-<version>.aw
 */

import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { deflateRawSync } from "node:zlib";

const MANIFEST = "manifest.json";

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** 递归收集文件（相对路径） */
function collectFiles(dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full, rel));
    } else {
      out.push({ rel, full });
    }
  }
  return out;
}

/** 构建 zip 二进制（deflate 压缩 + 标准结构） */
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  const encoder = new TextEncoder();

  for (const { rel, full } of entries) {
    const nameBuf = encoder.encode(rel);
    const data = readFileSync(full);
    const comp = deflateRawSync(data);
    const crc = crc32(data);
    const useComp = comp.length < data.length;

    // Local File Header
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(useComp ? 8 : 0, 8); // method
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(useComp ? comp.length : data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    localParts.push(local, nameBuf, useComp ? comp : data);

    // Central Directory Header
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(useComp ? 8 : 0, 10); // method
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0, 14); // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(useComp ? comp.length : data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(localParts.reduce((acc, p) => acc + p.length, 0) - local.length - nameBuf.length - (useComp ? comp.length : data.length) + local.length, 42); // local offset (approx: recompute below)
    centralParts.push(central, nameBuf);
  }

  // 修正 central 里的 local offset
  let offset = 0;
  let ci = 0;
  for (const { rel, full } of entries) {
    const nameLen = new TextEncoder().encode(rel).length;
    const data = readFileSync(full);
    const comp = deflateRawSync(data);
    const useComp = comp.length < data.length;
    const size = 30 + nameLen + (useComp ? comp.length : data.length);
    const central = centralParts[ci];
    central.writeUInt32LE(offset, 42);
    offset += size;
    ci += 2;
  }

  const centralSize = centralParts.reduce((acc, p) => acc + p.length, 0);
  const localSize = localParts.reduce((acc, p) => acc + p.length, 0);

  // EOCD
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(localSize, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

// ===== main =====
const args = process.argv.slice(2);
const src = args[0];
if (!src) {
  console.error("用法: node scripts/pack-aw.mjs <源目录> [-o 输出路径] [--name 覆盖名] [--version 覆盖版本]");
  process.exit(1);
}

const srcDir = resolve(src);
const manifestPath = join(srcDir, MANIFEST);
if (!statSync(manifestPath, { throwIfNoEntry: false })) {
  console.error(`✗ ${srcDir} 缺少 ${MANIFEST}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8").replace(/^\uFEFF/, ""));
if (manifest.type !== "plugin" && manifest.type !== "skill") {
  console.error(`✗ manifest.type 必须为 plugin 或 skill，当前: ${manifest.type}`);
  process.exit(1);
}

function argVal(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const name = argVal("--name", manifest.name) ?? "package";
const version = argVal("--version", manifest.version) ?? "1.0.0";
const outFlag = args.indexOf("-o");
const outPath = outFlag >= 0 && outFlag + 1 < args.length ? resolve(args[outFlag + 1]) : join(resolve("."), `${name}-${version}.aw`);

const files = collectFiles(srcDir);
const zipBuf = buildZip(files);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, zipBuf);

console.log(`✓ 打包完成: ${outPath}`);
console.log(`  type: ${manifest.type} | name: ${name} | version: ${version} | files: ${files.length} | size: ${(zipBuf.length / 1024).toFixed(1)} KB`);
