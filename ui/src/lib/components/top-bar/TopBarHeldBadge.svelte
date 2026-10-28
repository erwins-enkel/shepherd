<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import type { Gauge } from "../usage-gauges";
  import HeldSegment from "./HeldSegment.svelte";

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
      <HeldSegment
        count={heldCount}
        full={!(mobile || compactBadges)}
        resetAt={hotter?.w.resetAt ?? null}
        {nowMs}
      />
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
    /* shared bar control height, equal with its siblings */
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
  @media (pointer: coarse) {
    .held-badge {
      min-height: 44px;
      min-width: 44px;
    }
  }
</style>
