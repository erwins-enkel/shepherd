<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { formatResetIn } from "#lib/format.js";
  import type { Gauge } from "../usage-gauges";

  // The held-tasks trigger where the usage gauge can't carry it: the phone bar (no inline gauge)
  // and a desktop bar with no usage data. Either way it opens the shared usage panel, whose
  // waiting column lists the held tasks next to the numbers holding them.
  let {
    heldCount,
    mobile,
    compactBadges,
    hotter,
    nowMs,
    open,
    btn = $bindable(null),
    onToggle,
  }: {
    heldCount: number;
    mobile: boolean;
    compactBadges: boolean;
    hotter: Gauge | null;
    nowMs: number;
    open: boolean;
    btn: HTMLButtonElement | null;
    onToggle: () => void;
  } = $props();
</script>

{#if (heldCount ?? 0) > 0}
  <div class="held-wrap">
    <button
      bind:this={btn}
      class="held-badge"
      class:compact={mobile || compactBadges}
      class:mobile
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={m.topbar_held_badge({ count: heldCount ?? 0 })}
      onclick={onToggle}
    >
      <svg
        class="held-glyph"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M5 2h14M5 22h14" />
        <path d="M7 2v4.2a2 2 0 0 0 .6 1.4L12 12l4.4-4.4a2 2 0 0 0 .6-1.4V2" />
        <path d="M17 22v-4.2a2 2 0 0 0-.6-1.4L12 12l-4.4 4.4a2 2 0 0 0-.6 1.4V22" />
      </svg>
      {#if mobile || compactBadges}
        <span class="held-n">{heldCount}</span>
      {:else}
        <span>{m.topbar_held_badge({ count: heldCount ?? 0 })}</span>
        {#if hotter?.w.resetAt}
          <span class="held-reset"
            >{m.topbar_held_resets({ time: formatResetIn(hotter.w.resetAt, nowMs) })}</span
          >
        {/if}
      {/if}
    </button>
  </div>
{/if}

<style>
  /* ── Held-tasks badge ─────────────────────────────────────────────────────── */
  .held-wrap {
    position: relative;
  }
  .held-badge {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    /* shared bar control height; the hourglass glyph (#1122) centers instead of
       stretching the box, so it stays equal-height with its siblings */
    min-height: var(--topbar-ctl-h);
    line-height: 1;
    gap: 5px;
    background: transparent;
    border: 1px solid var(--color-amber);
    border-radius: var(--radius-chip);
    color: var(--color-amber);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    padding: 0 8px;
    cursor: pointer;
    white-space: nowrap;
  }
  .held-badge:hover {
    background: color-mix(in srgb, var(--color-amber) 10%, transparent);
  }
  /* Compact (mobile / measured-overflow) variant: a single-digit count centered in
     a square box — base .held-badge only centers vertically, and its letter-spacing
     trails the lone glyph leftward. */
  .held-badge.compact {
    justify-content: center;
    min-width: 44px;
    letter-spacing: 0;
    /* horizontal-only: box height comes from the shared --topbar-ctl-h min-height on
       the base rule, so no padding tuning is needed here */
    padding: 0 10px;
    /* pin the line box to 1×font-size so the box height is font-independent — this
       badge uses `font: inherit` (mono), whose `normal` line-height would otherwise
       drift the height by ~2px. */
    line-height: 1;
  }
  /* Width-gated 44px floor: `mobile` is width-only (≤768px), so fine-pointer narrow
     viewports need this — the coarse-pointer floor below does not cover them. Keyed off
     `mobile`, NOT `.compact`, so it never fires in the desktop measured-overflow case
     (where the compact badge keeps its natural ~36px height). */
  .held-badge.mobile {
    min-height: 44px;
  }
  .held-badge .held-glyph {
    width: 1.15em;
    height: 1.15em;
    display: block;
    flex-shrink: 0;
  }
  .held-badge .held-n {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .held-badge .held-reset {
    color: color-mix(in srgb, var(--color-amber) 70%, transparent);
    font-size: var(--fs-micro);
  }
  @media (pointer: coarse) {
    .held-badge {
      min-height: 44px;
      min-width: 44px;
    }
  }
</style>
