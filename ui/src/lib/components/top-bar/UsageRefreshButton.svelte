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
  {#if refreshError}
    <span class="usage-refresh-error" role="alert"
      >{m.topbar_usage_refresh_failed()} {m.common_retry()}</span
    >
  {/if}
  <button
    type="button"
    class="usage-refresh micro"
    disabled={refreshing}
    aria-busy={refreshing}
    onclick={onRefresh}
  >
    <span aria-hidden="true">↻</span>
    {refreshing ? m.topbar_usage_refreshing() : m.topbar_usage_refresh()}
  </button>
</div>

<style>
  .usage-refresh-row {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
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
    min-height: 30px;
    cursor: pointer;
  }
  .usage-refresh:hover:not(:disabled) {
    background: var(--color-inset);
  }
  .usage-refresh:focus-visible {
    outline: 1px solid var(--color-amber);
    outline-offset: 2px;
  }
  .usage-refresh:disabled {
    cursor: default;
    opacity: 0.5;
  }
  .usage-refresh-error {
    max-width: 24ch;
    font-size: var(--fs-micro);
    line-height: 1.35;
    text-align: right;
    color: var(--color-red);
  }
  @media (pointer: coarse) {
    .usage-refresh {
      min-height: 44px;
    }
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
</style>
