<script lang="ts">
  // The super-header over one kind of Up Next work: "Pull requests · waiting on you · N".
  let { title, sub, count }: { title: string; sub: string; count: number } = $props();
</script>

<div class="un-kind">
  <b>{title}</b><span>{sub}</span>
  <span class="un-kind-count">{count}</span>
</div>

<style>
  .un-kind {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 14px 14px 7px;
    font-size: var(--fs-micro);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .un-kind b {
    color: var(--color-ink-bright);
  }
  .un-kind-count {
    margin-left: auto;
    letter-spacing: 0;
  }
</style>
