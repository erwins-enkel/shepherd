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
    title={m.topbar_usage_refresh_scope()}
    disabled={refreshing}
    aria-busy={refreshing}
    onclick={onRefresh}
  >
    <svg
      class="refresh-glyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M20.5 12a8.5 8.5 0 1 1-2.49-6.01" />
      <path d="M20.5 3.5v5.5h-5.5" />
    </svg>
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
    display: inline-flex;
    align-items: center;
    gap: 7px;
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
  .refresh-glyph {
    width: 12px;
    height: 12px;
    flex: none;
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
