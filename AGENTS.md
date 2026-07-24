# AGENTS.md — AiWorker

## Quick commands
```bash
npm run dev          # run CLI via tsx (no build needed)
npm run build        # tsc → dist/
npm test             # vitest run (smoke-test.ts, 39 assertions)
```

- **No lint/formatter config** exists in this repo.
- **No `typecheck` script** — `tsc` runs as part of `npm run build`. Use `npx tsc --noEmit` for typecheck-only.

## Environment
- Requires `OPENAI_API_KEY` env var (used in `config/models.json` via `${OPENAI_API_KEY}`).
- Node >= 22.0.0.

## Architecture essentials

### ESM + `.js` import extensions (critical)
The project is `"type": "module"` (ESM). All **relative imports** must use the **`.js` extension** even when importing from `.ts` source files:
```ts
import { toolRegistry } from "./core/tool-registry.js";   // ← correct
import { toolRegistry } from "./core/tool-registry";      // ← will fail at runtime
```
`tsx` is more lenient, but compiled `dist/` code will break without `.js` extensions.

### Singleton pattern
`ToolRegistry`, `HookManager`, `AuditLog` are all singletons accessed via `.getInstance()`. Do not `new` them directly in new code — follow the existing pattern.

### Synchronous agent loop
The agent loop (`src/core/agent-loop.ts`) is synchronous — LLM latency is the bottleneck, not I/O. Tools execute sequentially within each iteration. Don't add async parallelism unless there's a measured reason.

### SQLite runtime data
- `data/` is gitignored. Databases (`aiworker.db`, `audit.db`) are created at runtime by `better-sqlite3` with WAL mode + FTS5.
- `better-sqlite3` is a **native C++ addon** — it requires a working C++ build toolchain or a prebuilt binary for the platform.
- Memory boundary files (`data/memory/MEMORY.md`, `data/memory/USER.md`) are bounded (≈2200 and ≈1375 chars respectively).

### Permission modes
Three modes: **ask** (read-only), **plan** (list before executing), **craft** (auto-execute, high-risk still prompts). Danger detection uses regex patterns in `src/security/danger-detector.ts`.

## Testing
- Only test file: `src/smoke-test.ts` (lives inside `src/`, not a separate `tests/` dir).
- Uses a custom `assert()` helper, **not** vitest's `expect`/`describe`/`it` DSL.
- Creates `data-test/` at runtime and cleans up on exit.
- Vitest has no config file — runs with defaults.
- Tests are excluded from `tsc` compilation (`tsconfig.json` excludes `tests` dir, but `smoke-test.ts` is in `src/` so it compiles anyway).

## CLI
```
npm start -- --dir /some/path --mode <ask|plan|craft> --data-dir <path>
```
Interactive mode defaults to `craft`. `/mode` command switches at runtime.
Uses **Commander.js** for arg parsing and **Inquirer** for prompts.

## Code conventions
- **kebab-case** filenames, e.g. `agent-loop.ts`, `hook-manager.ts`.
- All domain types in `src/types.ts`. Import with `import type { ... }`.
- `ToolResult` uses `success: boolean` + optional `error: string` everywhere.
- `HookResult` uses `proceed: boolean` for short-circuiting.
- Design doc in Chinese: `个人AI-Agent助手设计方案.md` (1278 lines).
