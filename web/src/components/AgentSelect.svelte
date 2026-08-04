<script lang="ts">
  let { agentId = "default", agents = [] as { id: string; name: string }[], onchange = (id: string) => {} } = $props();
</script>

<select value={agentId} onchange={(e) => onchange((e.target as HTMLSelectElement).value)}>
  {#each agents as a}
    <option value={a.id}>{a.name}</option>
  {/each}
</select>

<style>
  select {
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 20px;
    background: var(--surface);
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 12px;
    cursor: pointer;
    outline: none;
  }
  select:focus { border-color: var(--primary); }
</style>
