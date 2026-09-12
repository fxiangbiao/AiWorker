<script lang="ts">
  /**
   * HTML 产物预览（Sprint 50）— **唯一的 sandbox 策略实现**，产物面板与文件预览窗共用。
   *
   * 为什么必须 sandbox：`/api/v1/files` 与 Web 同源，而 index.html 里内联了 `window.__AIWORKER_TOKEN__`。
   * Agent 写的 HTML 一旦以同源文档执行，就能 `fetch("/")` 读出 token 再调写接口——等于把"产物"变成提权入口。
   * `sandbox="allow-scripts"`（**绝不给 allow-same-origin**）让文档拿到 opaque origin：
   * 脚本/画布/WebAudio 照常，但读不到应用源（localStorage、token、父窗口 DOM）。
   * 服务端在**导航请求**上另行追加 `CSP: sandbox allow-scripts`（见 `fileSecurityHeaders`），
   * 使"手动把 /files 的 URL 贴进地址栏"也同样降级。
   *
   * 已知边界（如实标注，不假装完整）：opaque origin 下 `type="module"` 脚本与相对 `import` 会被拦；
   * 引用同目录兄弟资源的相对路径也不会解析（iframes 的 URL 是 /files?path=…）——
   * 自包含单文件 HTML 不受影响，多文件站点需另加路径式预览路由。
   */
  let { src, title }: { src: string; title: string } = $props();
</script>

<iframe class="hp" {src} {title} sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>

<style>
  .hp {
    display: block;
    width: 100%;
    height: 100%;
    min-height: 240px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: #fff;
  }
</style>
