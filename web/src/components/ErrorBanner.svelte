<script lang="ts">
  const { message } = $props<{ message: string }>();
</script>

<div class="error-banner">{message}</div>

<style>
  .error-banner {
    background: #FEF2F2;
    border: 1px solid #FECACA;
    border-radius: var(--radius-sm);
    padding: 10px 14px;
    margin-bottom: 12px;
    color: var(--error);
    font-size: 12px;
    font-family: var(--font-mono);
  }
</style>
