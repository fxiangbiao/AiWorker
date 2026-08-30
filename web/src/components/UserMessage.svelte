<script lang="ts">
  import { esc } from "$lib/utils/format";

  let { content = "", images = [] as string[] } = $props();
</script>

<div class="msg user">
  <div class="bubble">
    {#if images.length > 0}
      <div class="imgs">
        {#each images as url (url)}
          <img class="img" src={url} alt="图片" />
        {/each}
      </div>
    {/if}
    {#if content}{esc(content)}{/if}
  </div>
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
  .imgs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
  .img { max-width: 220px; max-height: 160px; border-radius: var(--radius-sm); border: 1px solid var(--border); }
</style>
