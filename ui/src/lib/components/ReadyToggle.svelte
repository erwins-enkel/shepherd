<script lang="ts">
  // Single source for the per-session ready-to-merge toggle, rendered by GitRail —
  // the rail is the one lifecycle surface for it on every layout (Viewport's
  // identity row only mirrors the ON state as a passive pip). Keeping the a11y
  // label, on/off title, action and label text here means placements can't drift.
  // The *visibility gate* stays with the parent (GitRail's fetched git state).
  import { setReadyToMerge } from "$lib/api";
  import { m } from "$lib/paraglide/messages";

  let {
    sessionId,
    ready = false,
    mobile = false,
  }: {
    sessionId: string;
    ready?: boolean;
    // touch layout: enlarge to --mobile-actionbar-hit so the toggle matches its
    // .gbtn / .verdict-chip siblings instead of rendering half-height next to them.
    mobile?: boolean;
  } = $props();
</script>

<button
  class={["ready-toggle", { on: ready, mobile }]}
  type="button"
  aria-pressed={ready}
  aria-label={m.gitrail_ready_aria()}
  title={ready ? m.gitrail_ready_on_title() : m.gitrail_ready_off_title()}
  onclick={() => setReadyToMerge(sessionId, !ready)}
>
  {ready ? "✓ " : ""}{m.gitrail_ready()}
</button>

<style>
  /* matches the sibling .gbtn buttons in the GitRail rail */
  /* interactive control inside the git-rail chip row → 6px chip-row cohesion (DESIGN.md #1541) */
  .ready-toggle {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 6px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    white-space: nowrap;
    cursor: pointer;
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    transition:
      border-color 0.12s,
      color 0.12s;
  }
  .ready-toggle:hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  /* touch rail: match the full-height .gbtn / button.verdict-chip siblings so the
     toggle isn't a half-height odd-one-out beside the Reviewed chip */
  .ready-toggle.mobile {
    display: inline-flex;
    align-items: center;
    min-height: var(--mobile-actionbar-hit);
    padding: 6px 14px;
    font-size: var(--fs-base);
  }
  /* active = marked ready: green "on" look (parked / done) */
  .ready-toggle.on {
    color: var(--color-green);
    border-color: var(--color-green);
  }
  .ready-toggle.on:hover {
    border-color: var(--color-green);
    color: var(--color-green);
  }
</style>
