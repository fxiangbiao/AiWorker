<script lang="ts">
  /**
   * 设置 → 模型（Sprint 50 / IA 重构）
   * 合并了原先分散两处的同类信息：`配置` tab 的模型参数 + `设备` tab 的模型能力卡
   * （用户原话：同一件事两处看）。能力实测按钮也在这里——它是"配置的一部分"，不是"观测"。
   */
  import { configState, configError, configNotice, deviceStatus, deviceError, probeBusy, applyConfigField, probeModelVision } from "$lib/stores/settings.svelte";
  import { RefreshCw } from "lucide-svelte";

  let cfgModel = $state("");
  let cfgTemperature = $state("");
  let cfgMaxTokens = $state("");
  let newKey = $state("");
  let newModel = $state("");
  let newBase = $state("");
  let newProvider = $state("");
  let newKeyVal = $state("");
  let adding = $state(false);

  const VISION_SOURCE: Record<string, string> = { probe: "实测", config: "配置声明", unknown: "未验证" };

  // 首次拿到状态时回填草稿（用户手动改过后不覆盖：只在空值时填）
  $effect(() => {
    const c = $configState;
    if (!c) return;
    if (cfgModel === "") cfgModel = c.runtimeConfig.profileKey || "default";
    if (cfgTemperature === "" && c.runtimeConfig.temperature != null) cfgTemperature = String(c.runtimeConfig.temperature);
    if (cfgMaxTokens === "" && c.runtimeConfig.maxTokens != null) cfgMaxTokens = String(c.runtimeConfig.maxTokens);
  });

  async function addModel(): Promise<void> {
    adding = true;
    const ok = await applyConfigField("addModel", {
      key: newKey.trim(),
      model: newModel.trim(),
      baseURL: newBase.trim(),
      provider: newProvider.trim() || undefined,
      apiKey: newKeyVal.trim() || undefined,
    });
    adding = false;
    if (ok) {
      newKey = "";
      newModel = "";
      newBase = "";
      newProvider = "";
      newKeyVal = "";
    }
  }
</script>

<div class="sec">
  <div class="sec-head">
    <span class="sec-title">模型与生成参数</span>
  </div>

  {#if !$configState}
    <div class="note">{$configError || "正在读取配置…"}</div>
  {:else}
    <label class="row">模型
      <select class="input" value={cfgModel} onchange={(e) => void applyConfigField("profileKey", (e.currentTarget as HTMLSelectElement).value)}>
        {#each $configState.availableModels as m (m.key)}
          <option value={m.key}>{m.key}（{m.model}{m.provider ? ` · ${m.provider}` : ""}）</option>
        {/each}
      </select>
    </label>
    <label class="row">温度（0–2，空=默认）
      <input class="input" bind:value={cfgTemperature} placeholder="默认" />
      <button class="btn" onclick={() => void applyConfigField("temperature", cfgTemperature === "" ? null : Number(cfgTemperature))}>应用</button>
    </label>
    <label class="row">max-tokens（≥100，空=默认）
      <input class="input" bind:value={cfgMaxTokens} placeholder="默认" />
      <button class="btn" onclick={() => void applyConfigField("maxTokens", cfgMaxTokens === "" ? null : Number(cfgMaxTokens))}>应用</button>
    </label>
    <div class="row">
      <button class="btn" onclick={() => void applyConfigField("reset", undefined)}>恢复模型默认</button>
    </div>
  {/if}

  <div class="sec-sub">模型能力（实测）</div>
  {#if !$deviceStatus}
    <div class="note">{$deviceError || "正在读取设备状态…"}</div>
  {:else}
    <div class="row wrap">
      <span class="kv"><b>{$deviceStatus.model.current}</b></span>
      {#if $deviceStatus.model.provider}<span class="kv">{$deviceStatus.model.provider}</span>{/if}
      <span class="kv" class:ok={$deviceStatus.model.vision} class:bad={!$deviceStatus.model.vision}>
        {$deviceStatus.model.vision ? "🖼 支持图片输入" : "不支持图片输入"}
      </span>
      <span class="kv">来源：{VISION_SOURCE[$deviceStatus.model.visionSource ?? "unknown"]}</span>
      {#if $deviceStatus.model.contextWindow}<span class="kv">窗口 {$deviceStatus.model.contextWindow}</span>{/if}
      {#if $deviceStatus.model.temperature != null}<span class="kv">temp {$deviceStatus.model.temperature}</span>{/if}
      {#if $deviceStatus.model.maxTokens != null}<span class="kv">max {$deviceStatus.model.maxTokens}</span>{/if}
    </div>
    <div class="note">{$deviceStatus.model.detail}</div>
    {#if $deviceStatus.model.visionProbe}
      <div class="note">
        最近实测：{$deviceStatus.model.visionProbe.model} ·
        {$deviceStatus.model.visionProbe.supported === true ? "支持图片" : $deviceStatus.model.visionProbe.supported === false ? "拒绝图片" : "无法判定"}
        · {$deviceStatus.model.visionProbe.latencyMs}ms
        {#if $deviceStatus.model.visionProbe.stale}<b>（模型已切换，此结果失效）</b>{/if}
      </div>
    {/if}
    <div class="row">
      <button class="btn" disabled={$probeBusy} onclick={() => void probeModelVision()}>
        <RefreshCw size={12} /> {$probeBusy ? "检测中…（一次极小图片请求）" : "检测图片能力"}
      </button>
      <span class="note">不改配置，只发一次 1×1 图片请求并记下结论</span>
    </div>
  {/if}
  {#if $deviceError}<div class="err">{$deviceError}</div>{/if}

  <div class="sec-sub">添加模型 / Provider</div>
  <label class="row">key（唯一标识）
    <input class="input" bind:value={newKey} placeholder="如 my-gpt" />
  </label>
  <label class="row">模型名
    <input class="input" bind:value={newModel} placeholder="如 gpt-4o-mini" />
  </label>
  <label class="row">baseURL
    <input class="input" bind:value={newBase} placeholder="https://api.example.com/v1" />
  </label>
  <label class="row">provider（可选）
    <input class="input" bind:value={newProvider} placeholder="如 openai / deepseek" />
  </label>
  <label class="row">apiKey（可选，建议环境变量引用）
    <input class="input" bind:value={newKeyVal} placeholder={"${MY_API_KEY} 或留空继承默认"} />
  </label>
  <div class="row">
    <button class="btn" disabled={adding || !newKey.trim() || !newModel.trim() || !newBase.trim()} onclick={() => void addModel()}>添加模型</button>
    <span class="note">持久化到 data/runtime-config.json 与 config/models.json</span>
  </div>

  {#if $configNotice}<div class="ok">{$configNotice}</div>{/if}
  {#if $configError}<div class="err">{$configError}</div>{/if}
</div>

<style>
  .sec { display: flex; flex-direction: column; gap: 8px; }
  .sec-head { display: flex; align-items: center; justify-content: space-between; }
  .sec-title { font-size: 13px; font-weight: 600; }
  .sec-sub { font-size: 12px; font-weight: 600; color: var(--dim); margin-top: 6px; border-top: 1px solid var(--border); padding-top: 10px; }
  .row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text); }
  .row.wrap { flex-wrap: wrap; gap: 6px; }
  .input {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 12px;
    padding: 4px 6px;
    min-width: 120px;
    flex: 1 1 160px;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
  }
  .btn:hover:not(:disabled) { background: var(--hover-bg); }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .note { font-size: 11px; color: var(--dim); line-height: 1.55; }  .ok { font-size: 11px; color: var(--primary); }
  .err { font-size: 11px; color: var(--error); }
  .kv { font-size: 11px; color: var(--dim); border: 1px solid var(--border); border-radius: 3px; padding: 1px 5px; }
  .kv.ok { color: var(--success); border-color: var(--success); }
  .kv.bad { color: var(--error); border-color: var(--error); }
</style>
