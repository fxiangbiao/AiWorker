/**
 * 设备与能力动态探测测试（Sprint 49.4）
 * 覆盖：运行时/存储实测、实测缓存读写与损坏容错、视觉能力三级判定、
 *       模型探测（成功/拒绝/鉴权/超时）与探测请求本身（1×1 图片、thinking 关、低上限）
 */

import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import {
  detectRuntime,
  detectStorage,
  getDeviceStatus,
  readVisionProbe,
  resolveVisionCapability,
  writeVisionProbe,
  type VisionProbeRecord,
} from "../src/media/status.js";
import { ModelRouter } from "../src/core/model-router.js";
import { adapterRegistry } from "../src/core/llm/adapter-registry.js";
import type { LlmAdapter } from "../src/core/llm/llm-adapter.js";
import type { ModelCompleteOptions, Message } from "../src/types.js";
import { makeTestDir, setupEnv, teardownEnv } from "./helpers.js";

const testDir = makeTestDir("devices");
setupEnv(testDir);
afterAll(() => teardownEnv());

const MODEL = "deepseek-flash";

/** 最小可用 router 替身：只实现能力判定需要的读接口 */
function stubRouter(overrides: Record<string, unknown> = {}) {
  return {
    getCurrentModel: () => MODEL,
    getContextWindow: () => 1048576,
    getVisionDeclaration: () => undefined as boolean | undefined,
    getEffectiveProfile: () => ({
      provider: "deepseek",
      model: MODEL,
      baseURL: "https://api.deepseek.com",
      adapter: "openai-compatible",
      thinking: true,
      temperature: 0.3,
      maxTokens: 8192,
      contextWindow: 1048576,
      vision: undefined,
    }),
    ...overrides,
  } as never;
}

const record = (over: Partial<VisionProbeRecord> = {}): VisionProbeRecord => ({
  model: MODEL,
  supported: true,
  latencyMs: 42,
  at: "2026-09-12T12:00:00.000Z",
  detail: "端点接受了图片输入（实测）",
  ...over,
});

describe("运行时与存储动态探测", () => {
  it("运行时字段来自真实进程环境，数据目录可写性为实写探测", () => {
    const dir = join(testDir, "rt-ok");
    const rt = detectRuntime(dir);
    expect(rt.node).toMatch(/^v\d+/);
    expect(rt.cpus).toBeGreaterThan(0);
    expect(rt.totalMemGB).toBeGreaterThan(0);
    expect(rt.pid).toBe(process.pid);
    expect(rt.dataDirWritable).toBe(true);
    expect(rt.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it("数据目录不可写时报 false 而不是抛错", () => {
    const block = join(testDir, "rt-blocked");
    writeFileSync(block, "not a dir", "utf-8");
    const rt = detectRuntime(join(block, "child"));
    expect(rt.dataDirWritable).toBe(false);
  });

  it("存储探测真实建库并验证 FTS5（记忆检索依赖）", () => {
    const dir = join(testDir, "storage");
    mkdirSync(dir, { recursive: true });
    const st = detectStorage(dir);
    expect(st.ok).toBe(true);
    expect(st.fts5).toBe(true);
    expect(st.sqlite).toMatch(/^\d+\.\d+/);
    expect(st.dbPath).toBe(join(dir, "aiworker.db"));
    expect(st.dbPresent).toBe(false);

    writeFileSync(st.dbPath, Buffer.alloc(2048));
    const st2 = detectStorage(dir);
    expect(st2.dbPresent).toBe(true);
    expect(st2.dbSizeKb).toBe(2);
  });
});

describe("实测缓存读写与容错", () => {
  it("写入后可读回（含 null 结论与 error 字段）", () => {
    const dir = join(testDir, "probe-rt");
    expect(readVisionProbe(dir)).toBeNull();
    expect(writeVisionProbe(dir, record({ supported: null, error: "401 unauthorized" }))).toBe(true);
    const back = readVisionProbe(dir)!;
    expect(back.model).toBe(MODEL);
    expect(back.supported).toBeNull();
    expect(back.error).toBe("401 unauthorized");
  });

  it("文件损坏 / 字段非法 / 模型名为空 → 视为没有实测（不猜）", () => {
    const dir = join(testDir, "probe-bad");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "device-probe.json");
    writeFileSync(file, "{ 坏掉的 json", "utf-8");
    expect(readVisionProbe(dir)).toBeNull();

    writeFileSync(file, JSON.stringify({ model: MODEL, supported: "yes" }), "utf-8");
    expect(readVisionProbe(dir)).toBeNull();

    writeFileSync(file, JSON.stringify({ model: "", supported: true }), "utf-8");
    expect(readVisionProbe(dir)).toBeNull();
  });

  it("数据目录不可创建时写入返回 false（不影响探测结论）", () => {
    const block = join(testDir, "probe-blocked");
    writeFileSync(block, "x", "utf-8");
    expect(writeVisionProbe(join(block, "sub"), record())).toBe(false);
  });
});

describe("视觉能力三级判定（实测 → 配置声明 → 未声明）", () => {
  it("未实测且未声明 → unknown 且视为不支持", () => {
    const dir = join(testDir, "cap-unknown");
    const cap = resolveVisionCapability(dir, stubRouter());
    expect(cap.vision).toBe(false);
    expect(cap.source).toBe("unknown");
  });

  it("配置显式声明优先于缺省（含显式 false）", () => {
    const dir = join(testDir, "cap-config");
    expect(resolveVisionCapability(dir, stubRouter({ getVisionDeclaration: () => true }))).toMatchObject({
      vision: true,
      source: "config",
    });
    expect(resolveVisionCapability(dir, stubRouter({ getVisionDeclaration: () => false }))).toMatchObject({
      vision: false,
      source: "config",
    });
  });

  it("实测结论覆盖配置声明（声明缺失或写错时一律以实测为准）", () => {
    const dir = join(testDir, "cap-probe");
    writeVisionProbe(dir, record({ supported: true }));
    expect(resolveVisionCapability(dir, stubRouter({ getVisionDeclaration: () => false }))).toMatchObject({
      vision: true,
      source: "probe",
    });
    writeVisionProbe(dir, record({ supported: false }));
    expect(resolveVisionCapability(dir, stubRouter({ getVisionDeclaration: () => true }))).toMatchObject({
      vision: false,
      source: "probe",
    });
  });

  it("实测结果属于别的模型 → 失效，回落到配置声明", () => {
    const dir = join(testDir, "cap-stale");
    writeVisionProbe(dir, record({ model: "other-model", supported: true }));
    expect(resolveVisionCapability(dir, stubRouter({ getVisionDeclaration: () => false }))).toMatchObject({
      vision: false,
      source: "config",
    });
  });

  it("supported=null（无法判定）不作为结论使用", () => {
    const dir = join(testDir, "cap-null");
    writeVisionProbe(dir, record({ supported: null }));
    expect(resolveVisionCapability(dir, stubRouter({ getVisionDeclaration: () => true }))).toMatchObject({
      vision: true,
      source: "config",
    });
  });
});

describe("设备状态汇总（GET /devices 的载荷）", () => {
  it("包含运行时/存储/模型三项实测数据，且过期实测带 stale 标记", () => {
    const dir = join(testDir, "status-shape");
    mkdirSync(dir, { recursive: true });
    writeVisionProbe(dir, record({ model: "old-model", supported: true }));
    const st = getDeviceStatus(dir, stubRouter());
    expect(st.runtime.node).toMatch(/^v/);
    expect(st.storage.fts5).toBe(true);
    expect(st.model.current).toBe(MODEL);
    expect(st.model.provider).toBe("deepseek");
    expect(st.model.baseURL).toContain("deepseek.com");
    expect(st.model.vision).toBe(false);
    expect(st.model.visionSource).toBe("unknown");
    expect(st.model.visionProbe?.stale).toBe(true);
    expect(st.model.detail).toContain("未声明视觉能力");
    expect(st.asr.missing.length).toBeGreaterThan(0);
  });

  it("未配置采样参数时保持 undefined（不显示成 0）", () => {
    const dir = join(testDir, "status-unset");
    mkdirSync(dir, { recursive: true });
    const router = stubRouter({
      getEffectiveProfile: () => ({
        provider: "deepseek",
        model: MODEL,
        baseURL: "https://api.deepseek.com",
        contextWindow: 1048576,
      }),
    });
    const st = getDeviceStatus(dir, router);
    expect(st.model.temperature).toBeUndefined();
    expect(st.model.maxTokens).toBeUndefined();
    expect(st.model.thinking).toBeUndefined();
  });

  it("实测通过后状态直接反映，且 detail 说明来源", () => {
    const dir = join(testDir, "status-probe");
    mkdirSync(dir, { recursive: true });
    writeVisionProbe(dir, record());
    const st = getDeviceStatus(dir, stubRouter());
    expect(st.model.vision).toBe(true);
    expect(st.model.visionSource).toBe("probe");
    expect(st.model.visionProbe?.stale).toBeUndefined();
    expect(st.model.detail).toContain("实测通过");
  });
});

describe("ModelRouter.probeVision（真实发一次极小图片请求）", () => {
  const cfgDir = join(testDir, "probe-router");
  mkdirSync(cfgDir, { recursive: true });
  let captured: { conn: unknown; options: ModelCompleteOptions } | null = null;

  function routerWith(adapter: LlmAdapter): ModelRouter {
    adapterRegistry.register(adapter);
    const cfgPath = join(cfgDir, `models-${adapter.id}.json`);
    writeFileSync(
      cfgPath,
      JSON.stringify({
        default: {
          provider: "probe",
          model: MODEL,
          baseURL: "http://127.0.0.1:1/v1",
          apiKey: "k",
          temperature: 0.5,
          maxTokens: 4096,
          adapter: adapter.id,
          thinking: true,
        },
        profiles: {},
        routing: { strategy: "profile-based", fallback: "default" },
      }),
      "utf-8",
    );
    return new ModelRouter(cfgPath);
  }

  const okAdapter: LlmAdapter = {
    id: "probe-ok",
    complete: async (conn, options) => {
      captured = { conn, options };
      return { content: "红色", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    },
    completeStream: async function* () {},
  };

  it("端点接受图片 → supported=true，且请求确实是「文本 + 1×1 图片」且关思考、低上限", async () => {
    const router = routerWith(okAdapter);
    const r = await router.probeVision(5000);
    expect(r.supported).toBe(true);
    expect(r.model).toBe(MODEL);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);

    const opts = captured!.options as ModelCompleteOptions;
    expect(opts.maxTokens).toBe(12);
    const msg = opts.messages[0] as Message;
    const parts = msg.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts[1]!.image_url!.url.startsWith("data:image/png;base64,")).toBe(true);
    expect(Buffer.from(parts[1]!.image_url!.url.split(",")[1]!, "base64").subarray(0, 8).toString("hex")).toBe(
      "89504e470d0a1a0a",
    );
    expect((captured!.conn as { thinking?: boolean }).thinking).toBe(false);
  });

  it("端点明确拒绝图片 → supported=false 并保留原因", async () => {
    const router = routerWith({
      id: "probe-reject",
      complete: async () => {
        throw new Error("400 Bad Request: invalid content type image_url for this model");
      },
      completeStream: async function* () {},
    });
    const r = await router.probeVision(5000);
    expect(r.supported).toBe(false);
    expect(r.detail).toContain("拒绝图片");
    expect(r.error).toContain("image_url");
  });

  it("鉴权失败 → supported=null（不据此断言不支持视觉）", async () => {
    const router = routerWith({
      id: "probe-auth",
      complete: async () => {
        throw new Error("401 Unauthorized: invalid api key");
      },
      completeStream: async function* () {},
    });
    const r = await router.probeVision(5000);
    expect(r.supported).toBeNull();
    expect(r.detail).toContain("鉴权");
  });

  it("适配器不理 signal 也不会挂住：硬超时 → supported=null 且标注超时", async () => {
    const router = routerWith({
      id: "probe-hang",
      complete: () => new Promise(() => {}),
      completeStream: async function* () {},
    });
    const r = await router.probeVision(120);
    expect(r.supported).toBeNull();
    expect(r.detail).toContain("无法判定");
    expect(r.error).toContain("timeout");
  });

  it("缓存文件权限不影响探测结论（写入失败只降级 persisted）", () => {
    const dir = join(testDir, "probe-perm");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "device-probe.json");
    writeFileSync(file, "{}", "utf-8");
    try {
      chmodSync(file, 0o444);
    } catch {
      /* Windows 上可能无效，跳过该断言 */
    }
    rmSync(file, { force: true });
    expect(readVisionProbe(dir)).toBeNull();
  });
});
