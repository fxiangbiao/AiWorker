# Sprint 31 — 技能 / MCP / 插件 导入导出（统一 `.aw` 包）

> 状态：**✅ 已实施（0.6.0）**
> 需求：系统设置（TUI + Web）目前不支持技能、MCP、插件的导入；导出是导入的天然前提（分享/备份）
> 2026-08-22 决策：包格式由「.aiworker JSON 单文件」改为 **`.aw`（zip + manifest.json）**（用户确认"仅保留 .aw 整合方案"：工作区并行 .aw 实现（zip.ts/package-installer.ts/pack-aw.mjs//install）为主，补 mcp 类型 + 导出 + Web/HTTP + 修测试隔离；删除 .aiworker JSON 方案）

---

## 背景与现状

| 资产 | 存储 | 形态 |
|---|---|---|
| 技能 | `skills/<expert>/<name>/SKILL.md` | 单文件（YAML frontmatter: name/version/description/triggers/expert + body） |
| MCP | `config/mcp.json` | `{ servers: { name: {transport, command, args, url, enabled} } }` |
| 插件 | `config/plugins/<name>/` | 目录（plugin.ts/js + config.json + 可能附加文件） |

无任何导出/导入机制；session 已有导出（Markdown）。

## 一、统一包格式 `.aw`

**`.aw` = zip 压缩包**，内含 `manifest.json` + 资产文件。零第三方依赖（自研 `zip.ts`，支持 store/deflate）。

### manifest.json

```json
{
  "formatVersion": 1,
  "type": "skill" | "mcp" | "plugin",
  "name": "code-review",
  "version": "1.0.0",
  "description": "代码审查技能",
  "author": "fxb",
  "license": "MIT",
  "entry": "plugin.ts",          // plugin 入口（可选）
  "scope": "coding",             // 插件限定专家（可选，空=全局）
  "minAppVersion": "0.5.0",      // 兼容性检查（可选）
  "tags": ["code", "review"],    // 可选
  "signature": "sha256:..."      // 可选：分发签名
}
```

### 包内结构

| type | 必需文件 | 落盘位置 |
|---|---|---|
| skill | `SKILL.md` | `skills/<expert>/<name>/`（expert 从 frontmatter 取） |
| mcp | `mcp.json`（单 server 条目） | 合并进 `config/mcp.json` |
| plugin | `plugin.ts`/`plugin.js`/`index.ts`/`index.js`（任一） | `config/plugins/<name>/` |

### 打包工具 `scripts/pack-aw.mjs`

```bash
node scripts/pack-aw.mjs <源目录> [-o 输出] [--name 覆盖名] [--version 覆盖版本]
# 源目录须含 manifest.json；输出 <name>-<version>.aw
```

## 二、核心模块 `src/core/zip.ts` + `src/core/package-installer.ts`

### zip.ts（零依赖 zip 解析）
- `parseZip(buf): ZipEntry[]` — EOCD + Central Directory + Local Header 全解析
- `readZipEntry(buf, name)` / `readZipFile(path)` — 便捷读取
- 支持 store（method 0）+ deflate（method 8，`inflateRawSync`）

### package-installer.ts
- `readManifest(pkgPath): AwManifest` — 校验：`.aw` 后缀、formatVersion、type、包名正则 `[a-z0-9][a-z0-9_-]{0,63}`、版本号、minAppVersion
- `install(pkgPath, { force? }): InstallResult` — 解压落盘 + 类型专项校验（plugin 入口存在 / skill 有 SKILL.md）+ 路径穿越防护 + 幂等（同名拒绝，force 覆盖）
- `listInstalled()` — 按目录 + manifest 列出已安装
- 导出 `packageInstaller` 单例（config/plugins + skills）

## 三、安全（导入第三方包）

| 风险 | 对策 |
|---|---|
| 插件导入 = 执行任意代码 | 导入前明确警告（TUI 红色提示），需用户确认 |
| MCP 导入 = 启动外部进程/连外网 | 同上确认 |
| **路径穿越** | extract 前校验：目标必须在目标目录内（`relative` 检查），拒绝 `..`/绝对路径 |
| 覆盖误伤 | 同名冲突默认不覆盖，需 `force` 显式确认 |
| 坏包/缺文件 | 每类型专项校验（入口/SKILL.md），失败回滚（删除已写目录） |

## 四、接口

### CLI（注册到 plugins.ts，命令组 pluginsCommands）
- `/install <path> [-f]`（别名 `/pkg`）— 安装 .aw 包，按 manifest.type 路由；`-f` 覆盖
- `/plugins` — 查看插件（已有）；技能见 `/skills`

### 待办（本轮未实现，列入后续）
- `/pkg export <type> <name>` — 导出（需打包：目录 → .aw）
- HTTP 端点 `GET/POST /api/v1/packages/*`
- Web 三 Tab 导入/导出 UI
- MCP 类型的导入落盘（`mcp.json` 合并 + mcpManager 重连）

## 五、测试

- `package-installer.test.ts`（规划）：readManifest 校验 / install 落盘 / 路径穿越拒绝 / 同名冲突与 force / 缺 SKILL.md 拒绝 / listInstalled
- 手工端到端已通过：pack-aw.mjs 打包 → install → 校验（见 data-test/aw-test/verify-*.mjs）

## 六、文档与发布

- README / AGENTS.md：`.aw` 包格式说明 + `/install` 命令 + `pack-aw.mjs` 用法
- CHANGELOG：0.6.0（新功能批次）

## 实施顺序（已调整，反映实际进度）

1. ✅ zip.ts（零依赖解析）
2. ✅ package-installer.ts（manifest 校验 + 安装 + 安全）
3. ✅ /install 命令（plugins.ts）
4. ✅ scripts/pack-aw.mjs（打包工具）
5. ✅ 端到端验证（skill/plugin/路径穿越/缺文件）
6. ⏳ 正式单测 package-installer.test.ts
7. ⏳ /pkg export 命令 + HTTP 端点 + Web UI + MCP 类型（后续 Sprint 或本轮补完）
8. ⏳ 文档 + CHANGELOG 0.6.0

## 风险与对策

| 风险 | 对策 |
|---|---|
| 第三方插件执行恶意代码 | 导入确认警告 + README 安全提示（信任模型=用户自行判断） |
| zip 解析兼容性 | 自研解析仅支持 store/deflate（主流打包工具默认）；遇到其他方法明确报错 |
| mcp 重连失败 | loadConfig 已有 5s 超时保护 + 失败不影响现有服务器 |
| 包格式演进 | `formatVersion` 字段预留升级路径；校验宽松（未知字段忽略） |
