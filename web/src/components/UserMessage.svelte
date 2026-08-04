<script lang="ts">
  import { esc } from "$lib/utils/format";

  let { content = "" } = $props();
</script>

<div class="msg user">
  <div class="bubble">{esc(content)}</div>
</div>

<style>
  .msg { margin-bottom: 20px; }
  .bubble {
    font-size: 14px;
    line-height: 1.7;
    color: var(--text);
    background: var(--hover-bg);
    padding: 14px 18px;
    border-radius: var(--radius);
    display: inline-block;
    max-width: 85%;
  }
</style>
