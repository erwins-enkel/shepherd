<script lang="ts">
  // Single source for the per-session ready-to-merge toggle. Used by GitRail (the
  // mobile/unfolded git rail, variant="rail") and Viewport's desktop primary header
  // row (variant="bar"). Keeping the a11y label, on/off title, action and label text
  // here means the two placements can't drift; only the visual variant differs so each
  // matches its row's chrome (rail mirrors .gbtn; bar mirrors .git-toggle). The
  // *visibility gate* stays with each parent — its data source differs (GitRail's own
  // fetched git vs Viewport's git prop + desktop-only !compact).
  import { setReadyToMerge } from "$lib/api";
  import { m } from "$lib/paraglide/messages";

  let {
    sessionId,
    ready = false,
    variant = "rail",
    mobile = false,
  }: {
    sessionId: string;
    ready?: boolean;
    variant?: "rail" | "bar";
    // touch layout: rail-only enlargement so the toggle matches the ≥40px
    // .gbtn / .verdict-chip siblings instead of rendering half-height next to them.
    mobile?: boolean;
  } = $props();
</script>

<button
  class={["ready-toggle", variant, { on: ready, mobile: mobile && variant === "rail" }]}
  type="button"
  aria-pressed={ready}
  aria-label={m.gitrail_ready_aria()}
  title={ready ? m.gitrail_ready_on_title() : m.gitrail_ready_off_title()}
  onclick={() => setReadyToMerge(sessionId, !ready)}
>
  {ready ? "✓ " : ""}{m.gitrail_ready()}
</button>

<style>
  .ready-toggle {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    white-space: nowrap;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s;
  }
  /* rail variant: matches the sibling .gbtn buttons in the GitRail rail */
  .ready-toggle.rail {
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
  }
  .ready-toggle.rail:hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  /* touch rail: match the ≥40px .gbtn / button.verdict-chip siblings so the
     toggle isn't a half-height odd-one-out beside the Reviewed chip */
  .ready-toggle.rail.mobile {
    display: inline-flex;
    align-items: center;
    min-height: 40px;
    padding: 6px 14px;
    font-size: var(--fs-base);
  }
  /* bar variant: matches the .git-toggle disclosure in Viewport's primary row */
  .ready-toggle.bar {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    border-color: var(--color-line-bright);
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 2px 7px;
  }
  .ready-toggle.bar:hover {
    color: var(--color-ink);
  }
  /* active = marked ready: green "on" look (parked / done) */
  .ready-toggle.on {
    color: var(--color-green);
    border-color: var(--color-green);
  }
  .ready-toggle.bar.on {
    border-color: color-mix(in srgb, var(--color-green) 55%, transparent);
  }
  .ready-toggle.rail.on:hover {
    border-color: var(--color-green);
    color: var(--color-green);
  }
</style>
