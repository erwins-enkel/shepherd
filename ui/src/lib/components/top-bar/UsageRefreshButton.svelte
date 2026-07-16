<script lang="ts">
  import { m } from "$lib/paraglide/messages";

  // Manual re-scrape of `/usage`. Shared by the desktop popover and the mobile sheet so it lives at
  // the Claude-section level (not inside the credits block) — a hidden/absent credits gauge must not
  // take the only refresh control with it. Kept as its own component so the ternary + error branch
  // stay out of the parents' large templates (fallow template-complexity budget).
  let {
    refreshing,
    refreshError,
    onRefresh,
  }: {
    refreshing: boolean;
    refreshError: boolean;
    onRefresh: () => void;
  } = $props();
</script>

<div class="usage-refresh-row">
  <button
    type="button"
    class="usage-refresh micro"
    disabled={refreshing}
    aria-busy={refreshing}
    onclick={onRefresh}
  >
    {refreshing ? m.common_loading() : m.topbar_usage_refresh()}
  </button>
  {#if refreshError}
    <span class="usage-refresh-error micro" role="alert">{m.common_retry()}</span>
  {/if}
</div>

<style>
  .usage-refresh-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .usage-refresh {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    text-transform: none;
    letter-spacing: 0.04em;
    padding: 5px 10px;
    cursor: pointer;
  }
  .usage-refresh:hover:not(:disabled) {
    background: var(--color-inset);
  }
  .usage-refresh:disabled {
    cursor: default;
    opacity: 0.5;
  }
  .usage-refresh-error {
    text-transform: none;
    letter-spacing: 0.04em;
    color: var(--color-red);
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
</style>
