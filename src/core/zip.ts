/**
 * 极简 zip 读写（零依赖）：支持 store（无压缩）与 deflate（deflateRaw）
 * 仅用于 .aw 包：manifest.json 读取 + 文件解压 + 打包导出
 * 兼容性：标准 zip 结构（EOCD + Central Directory + Local Headers）
 */

import { inflateRawSync, deflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";

export interface ZipEntry {
  name: string;
  isDirectory: boolean;
  data: Buffer;
}

export interface ZipFileInput {
  name: string;
  data: Buffer;
}

function readU16(buf: Buffer, off: number): number {
  return buf.readUInt16LE(off);
}
function readU32(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off);
}

/** 解析 zip 缓冲，返回所有文件条目（含路径） */
export function parseZip(buf: Buffer): ZipEntry[] {
  // 1) 从尾部找 EOCD（End of Central Directory）
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 zip 文件（找不到 EOCD）");

  const cdCount = readU16(buf, eocd + 10);
  const cdOffset = readU32(buf, eocd + 16);
  const entries: ZipEntry[] = [];

  // 2) 遍历 Central Directory
  let off = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (readU32(buf, off) !== 0x02014b50) throw new Error("中央目录损坏");
    const method = readU16(buf, off + 10);
    const compSize = readU32(buf, off + 20);
    const nameLen = readU16(buf, off + 28);
    const extraLen = readU16(buf, off + 30);
    const commentLen = readU16(buf, off + 32);
    const localOff = readU32(buf, off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf-8");

    // 3) 从 Local Header 读取实际数据
    if (readU32(buf, localOff) !== 0x04034b50) throw new Error(`Local Header 损坏: ${name}`);
    const lNameLen = readU16(buf, localOff + 26);
    const lExtraLen = readU16(buf, localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    let data = buf.subarray(dataStart, dataStart + compSize);

    if (method === 8) {
      // deflate（deflateRaw）
      data = inflateRawSync(data);
    } else if (method !== 0) {
      throw new Error(`不支持的压缩方法 ${method}: ${name}`);
    }

    entries.push({
      name,
      isDirectory: name.endsWith("/"),
      data,
    });

    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 便捷：从 zip 缓冲提取单个文件 */
export function readZipEntry(buf: Buffer, name: string): Buffer | null {
  const entry = parseZip(buf).find((e) => e.name === name);
  return entry ? entry.data : null;
}

/** 从 .aw 文件路径读取 zip 缓冲 */
export function readZipFile(filePath: string): Buffer {
  return readFileSync(filePath);
}

// ── 打包（导出） ──

function crc32(buf: Buffer): number {
  let table = (crc32 as unknown as { table?: Int32Array }).table;
  if (!table) {
    table = (crc32 as unknown as { table?: Int32Array }).table = new Int32Array(256);
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

/** 构建 zip 二进制（deflate 压缩，压缩后更大则 store；与 scripts/pack-aw.mjs 结构一致） */
export function packZip(files: ZipFileInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf-8");
    const comp = deflateRawSync(data);
    const useComp = comp.length < data.length;
    const method = useComp ? 8 : 0;
    const stored = useComp ? comp : data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += 30 + nameBuf.length + stored.length;
  }

  const centralSize = centralParts.reduce((a, p) => a + p.length, 0);
  const localSize = localParts.reduce((a, p) => a + p.length, 0);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(localSize, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}
