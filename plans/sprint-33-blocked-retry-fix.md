# Sprint 33 — 高危拦截缺陷修复 + 工具错误展示/重试优化

> 状态：**✅ 已实施（0.6.6）**
> 需求：1) 分析高危操作拦截功能缺陷/漏洞；2) WEB UI 高危操作被拦截后点击"重试"没效果
> 2026-08-23 排查结论见下

---

## 一、高危拦截缺陷分析（已验证，含正则实测）

### 漏洞 1（严重）：`rm -rf` 相对路径/引号路径完全绕过

实测（`DangerDetector.check`）：

| 命令 | 结果 |
|---|---|
| `rm -rf /` / `~` / `$HOME` | ✅ 拦截 |
| **`rm -rf ./dist`** | ❌ **放行** |
| **`rm -rf node_modules`** | ❌ **放行** |
| **`rm -rf ../secrets`** | ❌ **放行** |
| **`rm -rf "my folder"`** | ❌ **放行** |
| `rm -rf /home/user/data` | ✅ 拦截 |

根因：`danger-detector.ts` 只匹配 `/rm\s+-rf\s+\//`、`/rm\s+-rf\s+~/`、`/rm\s+-rf\s+\$HOME/i` —— **目标必须以 `/`、`~`、`$HOME` 开头**，相对路径/引号路径全部漏掉。

### 漏洞 2（严重）：Windows 大小写绕过

**`RM -RF C:\Windows`** ❌ 放行。根因：`/rm\s+-rf\s+\//` 无 `i` 标志（仅 `$HOME` 那条有）。

### 漏洞 3（中）：Windows 参数顺序绕过

- `del /s /q C:\temp` ✅ 拦截，但 **`del /q /s C:\temp`** ❌ 放行（正则写死 `/s /q` 顺序）
- **`rd /s /q C:\x`** ❌ 放行（只匹配 `rmdir /s`，没覆盖 `rd` 别名）

### 漏洞 4（低）：`Remove-Item -Force -Recurse` 因 `Remove-Item\s+` 兜底被拦（行为保守，可接受）

### 缺陷 5（设计）：`checkCommandBlock` 语义

`approval-service.ts` L50-57：ask 模式高危**直接拦截**，plan/auto 模式**放行交给 confirmHighRisk**（弹确认）——设计意图 OK，但**依赖确认通道存在**；若确认通道缺失（fail-closed）则拒绝，行为正确。**无漏洞，但 plan 模式下 fs_write 只检测路径不检测 content**（L94-100 已注释说明，可接受）。

## 二、修复方案（danger-detector.ts 正则加固）

```ts
const DANGEROUS_PATTERNS = [
  // 文件系统（加固：任意目标 + 大小写 + 参数顺序）
  /rm\s+-rf\s+\S+/i,              // rm -rf <任意目标>（含相对路径/引号）
  /rm\s+-r\s+[^\s"']+/i,          // rm -r <目标>（保留）
  /rm\s+(?!-)(?:"[^"]+"|\S+)/i,   // rm <单文件>（保留）
  /rm\s+-r[f]?\s+["']?[^&|;]+/i,  // 兜底：rm -r/-rf + 引号内目标
  /del\s+(\/s\s*)?(\/q\s*)?[^\s&|;]+/i,   // del <目标> 任意 /s /q 顺序
  /(?:rd|rmdir)\s+\/s\b/i,        // rd / rmdir /s（覆盖别名）
  /Remove-Item.*-Recurse/i,       // 保留
  /Remove-Item\s+/i,              // 保留（兜底）
  ...
];
```

要点：全部加 `i`；`rm -rf` 匹配任意非空目标；`del` 的 `/s` `/q` 任意顺序；`rd`/`rmdir` 覆盖。

## 三、WEB UI"重试"没效果 — 根因

**根因 1：ToolCard 把所有 error 都显示为"操作被拦截"**

`ToolCard.svelte` L25-32：只要有 `tool.error` 就显示 `⚠ 操作被拦截` 标题 + 重试按钮。但用户遇到的 3 个 case 的 error 内容：

- case 1: `'Select-Object' is not recognized...` — **cmd 找不到命令**（命令执行失败，非拦截）
- case 2/3: `Command failed: chcp 65001 >nul & powershell ...` — **exec 命令失败**（非拦截）

这些是 **terminal_exec 执行失败**（命令错误/环境问题），不是高危拦截！UI 错误地统一标成"操作被拦截"，误导用户点重试。

**根因 2：retryTool 重发的是"用户消息"，不是"重试该工具"**

`ChatPanel.svelte` `retryTool`（L507-519）：把最后一条用户消息 + 附注"上次调用工具失败请重试"重新发给 LLM。对**命令执行失败**（如 Select-Object 不存在）重发消息让 LLM 重新生成命令——**有一定作用但不可控**；对**真正的拦截**（ask 模式），重发同样命令仍会被拦，除非 LLM 换命令。

**根因 3（代码缺陷）：`stream.sending` 时 retryTool 静默 return**

```ts
function retryTool(tool) {
  if (stream.sending) return;   // ← 流式未结束时点击重试，直接无响应
  ...
}
```
用户若在流式输出期间点重试，**点击无任何反应**。

## 四、WEB UI 修复方案

### 1. ToolCard：区分"被拦截"与"执行失败"

```svelte
<!-- error 含"拦截/禁止/高危/沙箱"关键词 → 被拦截；否则 → 执行失败 -->
{:else if tool.error}
  <div class="tc-bubble">
    <span class="tb-title">{isBlocked ? "⚠ 操作被拦截" : "⚠ 执行失败"}</span>
    <span class="tb-msg">{esc(tool.error)}</span>
    {#if onRetry}
      <button class="tb-retry" onclick={() => onRetry(tool)}>
        {isBlocked ? "调整后重试" : "重试"}
      </button>
    {/if}
  </div>
```

### 2. retryTool：修复静默 return + 附注按类型

```ts
function retryTool(tool) {
  if (stream.sending) {
    errors = [...errors, "当前正在生成中，请稍候再重试"];
    return;
  }
  const lastUser = [...store.messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return;
  const isBlocked = /拦截|禁止|不允许|高危|沙箱/.test(tool.error ?? "");
  const note = isBlocked
    ? `\n\n> ⚠️ 上次调用工具 \`${tool.name}\` 被系统拦截：${tool.error ?? ""}。请更换实现方式（如改用 fs_write 或调整命令），不要重复相同操作。`
    : `\n\n> ⚠️ 上次调用工具 \`${tool.name}\` 失败：${tool.error ?? ""}。请修正后重试。`;
  ...
}
```

### 3. （可选）terminal_exec 命令失败信息更清晰

case 1 的 `Select-Object is not recognized` 是 **cmd 直接执行**导致（PowerShell 语法不能直接跑在 cmd）。`execCmdHandler` 已用 `chcp 65001 >nul & ${command}` 包装——模型若生成纯 PowerShell 管道命令（`... | Select-Object`）会失败。建议 terminal_exec 描述补充"Windows 下命令在 cmd 中执行，PowerShell 语法需用 `powershell -Command` 包裹"。

## 五、验证

1. `npm test`（新增 danger-detector 加固用例：相对路径/大小写/参数顺序/rd 别名）
2. `web build` 通过
3. 实机：造一条 `rm -rf ./dist` 确认拦截；Web 端模拟失败工具确认标题区分
4. 双 remote push

## 六、涉及文件

| 文件 | 改动 |
|---|---|
| `src/security/danger-detector.ts` | 正则加固（rm 任意目标/大小写/del 顺序/rd 别名） |
| `test/core.test.ts` | 新增加固用例 |
| `web/src/components/ToolCard.svelte` | 标题区分"拦截/执行失败" + 按钮文案 |
| `web/src/components/ChatPanel.svelte` | retryTool：sending 反馈 + 按类型附注 |
| `src/tools/builtin.ts` | terminal_exec 描述补 Windows cmd 提示 |
