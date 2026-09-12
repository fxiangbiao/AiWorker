<script lang="ts">
  /**
   * 设置 → 关于（Sprint 50 / IA 重构）
   * 版本 / 数据目录 / 存储 / 运行时——都是"看一眼"的信息，但归属于设置（它描述这套安装的现状）。
   * 数据来自 `/status`（版本、工作目录）与 `/devices`（存储、运行时），不再另开端点。
   */
  import { configState, deviceStatus, deviceError, loadDeviceStatus } from "$lib/stores/settings.svelte";
  import { workingDir, currentModel } from "$lib/stores/status";
  import { RefreshCw } from "lucide-svelte";
</script>

<div class="sec">
  <div class="sec-block">
    <div class="sec-title">版本</div>
    <div class="row"><span class="kv">AiWorker</span><b>v{$configState?.appVersion ?? "…"}</b></div>
    <div class="row"><span class="kv">当前模型</span><span class="path">{$currentModel || $configState?.model || "—"}</span></div>
    <div class="row"><span class="kv">工作目录</span><span class="path">{$workingDir || "（未连接）"}</span></div>
  </div>

  <div class="sec-block">
    <div class="sec-head">
      <span class="sec-title">运行时与存储</span>
      <button class="btn" onclick={() => void loadDeviceStatus()}><RefreshCw size={12} /> 重新检测</button>
    </div>
    {#if !$deviceStatus}
      <div class="note">{$deviceError || "正在读取…"}</div>
    {:else}
      {#if $deviceStatus.runtime}
        <div class="row"><span class="kv">{`Node ${$deviceStatus.runtime.node}`}</span><span class="kv">{$deviceStatus.runtime.platform} / {$deviceStatus.runtime.arch}</span><span class="kv">{$deviceStatus.runtime.cpus} 核</span><span class="kv">内存 {$deviceStatus.runtime.freeMemGB}/{$deviceStatus.runtime.totalMemGB} GB</span></div>
        <div class="note">{$deviceStatus.runtime.cpuModel}</div>
        <div class="row"><span class="kv">数据目录</span><span class="path">{$deviceStatus.runtime.dataDir}</span><span class="kv" class:ok={$deviceStatus.runtime.dataDirWritable} class:bad={!$deviceStatus.runtime.dataDirWritable}>{$deviceStatus.runtime.dataDirWritable ? "可写" : "不可写"}</span></div>
      {/if}
      {#if $deviceStatus.storage}
        <div class="row">
          <span class="kv">SQLite {$deviceStatus.storage.sqlite || "不可用"}</span>
          <span class="kv" class:ok={$deviceStatus.storage.fts5} class:bad={!$deviceStatus.storage.fts5}>{$deviceStatus.storage.fts5 ? "FTS5 可用" : "FTS5 不可用"}</span>
          <span class="kv">{$deviceStatus.storage.dbPresent ? `库 ${$deviceStatus.storage.dbSizeKb} KB` : "库尚未创建"}</span>
        </div>
        <div class="note path" title={$deviceStatus.storage.dbPath}>{$deviceStatus.storage.dbPath}</div>
        {#if $deviceStatus.storage.error}<div class="err">{$deviceStatus.storage.error}</div>{/if}
      {/if}
    {/if}
    {#if $deviceError}<div class="err">{$deviceError}</div>{/if}
  </div>

  <div class="sec-block">
    <div class="sec-title">配置文件</div>
    <div class="note">模型与生成参数写入 <code>data/runtime-config.json</code> 与 <code>config/models.json</code>；权限规则写入 <code>config/permissions.json</code>；沙箱策略写入 <code>&lt;--dir&gt;/config/sandbox.json</code>。</div>
    <div class="note">语音设备（ASR / TTS / 媒体服务器）状态在「控制台 → 系统」查看与下载。</div>
  </div>
</div>

<style>
  .sec { display: flex; flex-direction: column; gap: 12px; }
  .sec-block { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px; }
  .sec-head { display: flex; align-items: center; justify-content: space-between; }
  .sec-title { font-size: 12px; font-weight: 600; }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; }
  .btn {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 4px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface); color: var(--text); font-size: 12px; cursor: pointer;
  }
  .btn:hover { background: var(--hover-bg); }
  .note { font-size: 11px; color: var(--dim); line-height: 1.55; }
  .note code { font-family: var(--font-mono); font-size: 10.5px; }
  .err { font-size: 11px; color: var(--error); }
  .kv { font-size: 11px; color: var(--dim); border: 1px solid var(--border); border-radius: 3px; padding: 1px 5px; }
  .kv.ok { color: var(--success); border-color: var(--success); }
  .kv.bad { color: var(--error); border-color: var(--error); }
  .path { font-family: var(--font-mono); font-size: 10.5px; color: var(--text); word-break: break-all; }
</style>
