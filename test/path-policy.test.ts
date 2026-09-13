/**
 * 路径策略单点测试（Sprint 49 / P1-7）
 * 覆盖：根的解析与回退 / 越界拒绝（读与写）/ 符号链接真实路径 / 读根写根不对称 /
 *       不存在的尾段（新建文件）/ 关闭开关 / 空路径 fail-closed / 策略注入与还原
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, resolve, sep } from "node:path";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { makeTestDir, makeDirLink, makeDanglingLink, DIR_LINK_SUPPORTED } from "./helpers.js";
import {
  buildPathPolicy,
  evaluatePath,
  isInsideDir,
  resolvePathPolicy,
  resolveRealPath,
  resolveRoots,
  setPathPolicyOverride,
} from "../src/security/path-policy.js";

const testDir = makeTestDir("path-policy");
const root = join(testDir, "root");
const outside = join(testDir, "outside");

describe("路径策略单点（Sprint 49）", () => {
  beforeEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "secret", "utf-8");
  });

  afterEach(() => {
    setPathPolicyOverride(null);
  });

  it("默认根的解析：留空回退工作目录，相对根解析为绝对真实路径", () => {
    const policy = buildPathPolicy(root, {});
    expect(policy.enabled).toBe(true);
    expect(policy.readRoots).toEqual([resolveRealPath(root)]);
    expect(policy.writeRoots).toEqual([resolveRealPath(root)]);

    const roots = resolveRoots([outside, outside, "."], root);
    expect(roots).toHaveLength(2);
    expect(roots[0]).toBe(resolveRealPath(outside));
    expect(roots[1]).toBe(resolveRealPath("."));
  });

  it("根内放行、相对路径按工作目录解析、子目录放行", () => {
    const policy = buildPathPolicy(root, {});
    mkdirSync(join(root, "sub"), { recursive: true });
    expect(evaluatePath("read", "a.txt", policy, root).allowed).toBe(true);
    expect(evaluatePath("write", "sub/b.txt", policy, root).allowed).toBe(true);
    expect(evaluatePath("write", ".", policy, root).allowed).toBe(true);
    expect(isInsideDir(resolveRealPath(root), resolveRealPath(join(root, "sub")))).toBe(true);
  });

  it("越界拒绝：../ 与绝对路径都拦截，读写各自给出策略原因", () => {
    const policy = buildPathPolicy(root, {});
    const up = evaluatePath("write", join("..", "outside", "x.txt"), policy, root);
    expect(up.allowed).toBe(false);
    expect(up.reason).toContain("写入越界");

    const abs = evaluatePath("read", join(outside, "secret.txt"), policy, root);
    expect(abs.allowed).toBe(false);
    expect(abs.reason).toContain("读取越界");
    expect(abs.reason).toContain("allowReadDirs");

    // 相邻前缀目录不误判（root-other 与 root 同前缀）
    const sibling = `${root}-other`;
    expect(evaluatePath("write", join(sibling, "x.txt"), policy, root).allowed).toBe(false);
  });

  it("读根与写根不对称：allowReadDirs 只放宽读，allowWriteDirs 只放宽写", () => {
    const readOnly = buildPathPolicy(root, { allowReadDirs: [outside] });
    expect(evaluatePath("read", join(outside, "secret.txt"), readOnly, root).allowed).toBe(true);
    expect(evaluatePath("write", join(outside, "new.txt"), readOnly, root).allowed).toBe(false);

    const writeOnly = buildPathPolicy(root, { allowWriteDirs: [outside] });
    expect(evaluatePath("write", join(outside, "new.txt"), writeOnly, root).allowed).toBe(true);
    expect(evaluatePath("read", join(outside, "secret.txt"), writeOnly, root).allowed).toBe(false);
  });

  it.skipIf(!DIR_LINK_SUPPORTED)("符号链接越界被拦截（真实路径判定，词法比较会放过的场景）", () => {
    const link = join(root, "esc");
    expect(makeDirLink(link, outside)).toBe(true);
    // 词法比较：esc/pwned.txt 看起来在工作目录内
    const lexical = resolve(link, "pwned.txt");
    expect(isInsideDir(resolve(root), lexical)).toBe(true);

    const decision = evaluatePath("write", join(link, "pwned.txt"), buildPathPolicy(root, {}), root);
    expect(decision.allowed).toBe(false);
    expect(decision.resolved).toBe(resolveRealPath(join(outside, "pwned.txt")));
    expect(decision.resolved.toLowerCase()).toContain("outside");

    // 写根显式放宽到真实目标时放行（证明拦截来自路径解析而非其他因素）
    const widened = buildPathPolicy(root, { allowWriteDirs: [outside] });
    expect(evaluatePath("write", join(link, "pwned.txt"), widened, root).allowed).toBe(true);
  });

  it("不存在的尾段按最近存在祖先解析（新建文件在根内仍放行）", () => {
    const nested = join(root, "a", "b", "c.txt");
    const decision = evaluatePath("write", nested, buildPathPolicy(root, {}), root);
    expect(decision.allowed).toBe(true);
    expect(decision.resolved).toBe(resolve(nested));
  });

  it("解析失败一律拒绝：组件数超限（无需链接权限，审查修复的 fail-open 路径）", () => {
    const policy = buildPathPolicy(root, {});
    // 513 层以上组件即放弃解析（旧实现剥层用尽后退回词法 → 放行）
    const deep = join(root, ...Array.from({ length: 600 }, (_, i) => `d${i}`), "pwn.txt");
    expect(resolveRealPath(deep)).toBeNull();
    const d = evaluatePath("write", deep, policy, root);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("无法解析");
  });

  it.skipIf(!DIR_LINK_SUPPORTED)("解析失败一律拒绝：悬空链接与链接环（审查修复的 fail-open 路径）", () => {
    const policy = buildPathPolicy(root, {});

    // 悬空链接：链接存在但目标不存在 → 不能当成"路径不存在"退化成词法判定
    const dangling = join(root, "dangle.txt");
    expect(makeDanglingLink(dangling, join(outside, "not-there.txt"))).toBe(true);
    expect(resolveRealPath(dangling)).toBeNull();
    const d = evaluatePath("write", dangling, policy, root);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("无法解析");

    // 链接环 a → b → a：realpath 必然失败，同样按拒绝处理（不得退化成词法判定）
    const a = join(root, "ring-a");
    const b = join(root, "ring-b");
    if (makeDirLink(a, b) && makeDirLink(b, a)) {
      expect(resolveRealPath(a)).toBeNull();
      const ring = evaluatePath("write", join(a, "pwn.txt"), policy, root);
      expect(ring.allowed).toBe(false);
      expect(ring.reason).toContain("无法解析");
    }
  });

  it.skipIf(!DIR_LINK_SUPPORTED)("组件数超限 + 链接指到根外：不因剥层用尽而放行", () => {
    const policy = buildPathPolicy(root, {});
    expect(makeDirLink(join(root, "deepesc"), outside)).toBe(true);
    const deep = join(root, "deepesc", ...Array.from({ length: 45 }, (_, i) => `d${i}`), "pwn.txt");
    expect(evaluatePath("write", deep, policy, root).allowed).toBe(false);
    // 对照：浅层链接路径正常拦截
    expect(evaluatePath("write", join(root, "deepesc", "d0", "pwn.txt"), policy, root).allowed).toBe(false);
  });

  it("`..` 开头的合法文件名不被误判越界（审查修复）", () => {
    const policy = buildPathPolicy(root, {});
    for (const name of ["..data/f.txt", "..cache/x.txt", "..foo.txt"]) {
      expect(isInsideDir(root, join(root, name))).toBe(true);
      expect(evaluatePath("write", name, policy, root).allowed, name).toBe(true);
    }
    expect(isInsideDir(root, join(root, "..", "outside", "x.txt"))).toBe(false);
    expect(evaluatePath("write", "../outside/x.txt", policy, root).allowed).toBe(false);
  });

  it.skipIf(!DIR_LINK_SUPPORTED)("相对路径中的 `..` 在**解析之后**弹出（与内核一致：link\\..\\x 先解开 link）", () => {
    expect(makeDirLink(join(root, "linkup"), outside)).toBe(true);
    // 注意：不能用 join() 构造——它会先把 `..` 折叠掉，测的就不是真实解析了
    const raw = `${root}${sep}linkup${sep}..${sep}pwn.txt`;
    const decision = evaluatePath("write", raw, buildPathPolicy(root, {}), root);
    expect(isInsideDir(root, decision.resolved)).toBe(false);
    expect(decision.allowed).toBe(false);

    // 对照：不含链接的 `..` 仍按词法弹出，落在根内
    const plain = `${root}${sep}sub${sep}..${sep}ok.txt`;
    expect(isInsideDir(root, evaluatePath("write", plain, buildPathPolicy(root, {}), root).resolved)).toBe(true);
  });

  it("关闭策略全部放行；空路径与非法入参 fail-closed", () => {
    const off = buildPathPolicy(root, { enabled: false });
    expect(evaluatePath("write", join(outside, "x.txt"), off, root).allowed).toBe(true);
    expect(evaluatePath("read", "C:/anywhere/x.txt", off, root).allowed).toBe(true);

    const on = buildPathPolicy(root, {});
    expect(evaluatePath("read", "", on, root).allowed).toBe(false);
    expect(evaluatePath("read", "   ", on, root).allowed).toBe(false);
    expect(evaluatePath("write", undefined as unknown as string, on, root).reason).toContain("为空");
  });

  it("策略注入生效并可还原（测试与装配层用）", () => {
    const injected = buildPathPolicy(root, { allowWriteDirs: [outside] });
    setPathPolicyOverride(injected);
    expect(resolvePathPolicy(root, {})).toBe(injected);
    expect(evaluatePath("write", join(outside, "x.txt"), resolvePathPolicy(root, {}), root).allowed).toBe(true);

    setPathPolicyOverride(null);
    expect(resolvePathPolicy(root, {})).not.toBe(injected);
    expect(evaluatePath("write", join(outside, "x.txt"), resolvePathPolicy(root, {}), root).allowed).toBe(false);
  });

  it("realpath 解析到真实路径（含大小写规范化）", () => {
    const file = join(root, "real.txt");
    writeFileSync(file, "x", "utf-8");
    expect(resolveRealPath(file)).toBe(realpathSync(file));
    expect(resolveRealPath(join(root, "not-there.txt"))).toBe(resolve(join(root, "not-there.txt")));
  });

  it.skipIf(process.platform !== "win32")("Windows 保留设备名与 ADS 被拒绝（此前假成功）", () => {
    const policy = buildPathPolicy(root, {});
    for (const name of ["NUL", "CON", "sub/COM1", "a.txt:ads"]) {
      const d = evaluatePath("write", name, policy, root);
      expect(d.allowed, name).toBe(false);
      expect(d.reason, name).toMatch(/保留设备名|备用数据流/);
    }
  });

  /** 环境不支持创建目录链接时显式 skip（原因：Windows 需开发者模式/管理员） */
  describe.skipIf(!DIR_LINK_SUPPORTED)("符号链接真实路径判定", () => {
    it("符号链接越界被拦截（词法比较会放过的场景）", () => {
      const link = join(root, "esc");
      expect(makeDirLink(link, outside)).toBe(true);
      // 词法比较：esc/pwned.txt 看起来在工作目录内
      const lexical = resolve(link, "pwned.txt");
      expect(isInsideDir(resolve(root), lexical)).toBe(true);

      const decision = evaluatePath("write", join(link, "pwned.txt"), buildPathPolicy(root, {}), root);
      expect(decision.allowed).toBe(false);
      expect(decision.resolved.toLowerCase()).toContain("outside");

      // 写根显式放宽到真实目标时放行（证明拦截来自路径解析而非其他因素）
      const widened = buildPathPolicy(root, { allowWriteDirs: [outside] });
      expect(evaluatePath("write", join(link, "pwned.txt"), widened, root).allowed).toBe(true);
    });

    it("不存在的尾段位于符号链接之下时仍按真实目标判定", () => {
      const link = join(root, "esc2");
      expect(makeDirLink(link, outside)).toBe(true);
      const escaped = evaluatePath("write", join(link, "deep", "1", "x.txt"), buildPathPolicy(root, {}), root);
      expect(escaped.allowed).toBe(false);
      expect(escaped.resolved.toLowerCase()).toContain("outside");
    });
  });
});
