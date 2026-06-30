<script lang="ts">
  import type { HerdFilter } from "$lib/components/herd-partition";
  import { m } from "$lib/paraglide/messages";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";

  let {
    filter = $bindable<HerdFilter>(),
    statusFilter,
    statusLabel,
    collapsible,
    owedCount = 0,
    onstatusfilter,
    oncollapse,
  }: {
    filter: HerdFilter;
    statusFilter: "running" | "idle" | "blocked" | null;
    statusLabel: string;
    collapsible: boolean;
    /** Outstanding post-merge owed records (#1257) — drives the OWED lens count badge; 0 hides it. */
    owedCount?: number;
    onstatusfilter?: (status: "running" | "idle" | "blocked" | null) => void;
    oncollapse?: () => void;
  } = $props();

  // Bound the badge width so a large count can't perturb the fixed 6-lens single-row grid.
  const owedBadge = $derived(owedCount > 99 ? "99+" : String(owedCount));
</script>

<!-- Desktop / touch-wide lens strip: replaces the inline .fbtn filter row that overflowed
     the ~300–360px sidebar header. Icon-over-label segments, full-bleed so it spans the
     panel width and becomes its top edge (the "The Herd" title is dropped). The decorative
     glyph is aria-hidden, so each segment's accessible name is its label alone. The strip
     sets its OWN container (container-type: inline-size) — the `herd` container lives on the
     sibling .units subtree and is unreachable here — so a @container query can shrink the
     label font at narrow widths and keep all six lenses on one row down to the 300px floor.
     The status chip (top-bar tally) and the touch-wide collapse control, which the old
     inline row carried, are rehomed to thin rows below / above the strip. -->
{#if collapsible}
  <div class="collapse-row">
    <button
      id="herd-collapse-btn"
      type="button"
      class="collapse-inline"
      title={m.herd_collapse()}
      aria-label={m.herd_collapse()}
      onclick={() => oncollapse?.()}>‹</button
    >
  </div>
{/if}

<div class="lens-strip" role="group" aria-label={m.herd_lenses_label()}>
  <button
    type="button"
    class="lens lens-next"
    class:on={statusFilter == null && filter === "next"}
    title={m.herd_next_title()}
    aria-pressed={statusFilter == null && filter === "next"}
    use:coachTarget={"up-next-lens"}
    onclick={() => {
      filter = "next";
      onstatusfilter?.(null);
    }}
  >
    <span class="ic" aria-hidden="true">↑</span>
    <span class="lb">{m.herd_seg_next()}</span>
  </button>
  <button
    type="button"
    class="lens"
    class:on={statusFilter == null && filter === "all"}
    title={m.herd_all_title()}
    aria-pressed={statusFilter == null && filter === "all"}
    onclick={() => {
      filter = "all";
      onstatusfilter?.(null);
    }}
  >
    <span class="ic" aria-hidden="true">▦</span>
    <span class="lb">{m.herd_seg_all()}</span>
  </button>
  <button
    type="button"
    class="lens"
    class:on={statusFilter == null && filter === "ready"}
    title={m.herd_ready_title()}
    aria-pressed={statusFilter == null && filter === "ready"}
    onclick={() => {
      filter = "ready";
      onstatusfilter?.(null);
    }}
  >
    <span class="ic" aria-hidden="true">▤</span>
    <span class="lb">{m.herd_seg_ready()}</span>
  </button>
  <button
    type="button"
    class="lens"
    class:on={statusFilter == null && filter === "done"}
    title={m.herd_done_title()}
    aria-pressed={statusFilter == null && filter === "done"}
    use:coachTarget={"done-lens"}
    onclick={() => {
      filter = "done";
      onstatusfilter?.(null);
    }}
  >
    <span class="ic" aria-hidden="true">✓</span>
    <span class="lb">{m.herd_seg_done()}</span>
  </button>
  <button
    type="button"
    class="lens"
    class:on={statusFilter == null && filter === "rundown"}
    title={m.herd_rundown_title()}
    aria-pressed={statusFilter == null && filter === "rundown"}
    use:coachTarget={"herd-rundown"}
    onclick={() => {
      filter = "rundown";
      onstatusfilter?.(null);
    }}
  >
    <span class="ic" aria-hidden="true">☰</span>
    <span class="lb">{m.herd_seg_rundown()}</span>
  </button>
  <button
    type="button"
    class="lens lens-owed"
    class:on={statusFilter == null && filter === "owed"}
    title={owedCount > 0 ? m.herd_owed_count({ count: owedCount }) : m.herd_owed_title()}
    aria-pressed={statusFilter == null && filter === "owed"}
    use:coachTarget={"owed-lens"}
    onclick={() => {
      filter = "owed";
      onstatusfilter?.(null);
    }}
  >
    <span class="ic" aria-hidden="true">☑</span>
    <span class="lb">{m.herd_seg_owed()}</span>
    {#if owedCount > 0}
      <span class="owed-badge" aria-label={m.herd_owed_count({ count: owedCount })}
        >{owedBadge}</span
      >
    {/if}
  </button>
</div>

{#if statusFilter != null}
  <div class="chip-row">
    <!-- aria-label carries status + clear action; the visible "✕" glyph alone would be read
         aloud without conveying what the chip does -->
    <button
      type="button"
      class="statchip"
      title={m.topbar_tally_clear_title()}
      aria-label={m.herd_status_chip_aria({ status: statusLabel })}
      aria-pressed="true"
      onclick={() => onstatusfilter?.(null)}>{statusLabel} ✕</button
    >
  </div>
{/if}

<style>
  /* Touch-wide-only collapse control, rehomed above the strip (the old inline row carried
     it). Only rendered when `collapsible` — i.e. touch-primary wide devices. */
  .collapse-row {
    display: flex;
    justify-content: flex-end;
    padding: 2px 8px;
    border-bottom: 1px solid var(--color-line);
  }
  .collapse-inline {
    border: 0;
    background: none;
    color: var(--color-muted);
    cursor: pointer;
    font-size: var(--fs-lg);
    line-height: 1;
    padding: 2px 6px;
  }
  .collapse-inline:hover {
    color: var(--color-ink);
  }

  .lens-strip {
    /* own container so the label-shrink @container query below can fire (the `herd`
       container is on the sibling .units subtree, unreachable from here) */
    container-type: inline-size;
    display: grid;
    /* six lenses on one row down to the 300px sidebar floor (6×44=264 ≤ inner width);
       wraps only at the narrowest compact widths (<264) */
    grid-template-columns: repeat(auto-fit, minmax(44px, 1fr));
    border-bottom: 1px solid var(--color-line);
  }
  .lens {
    min-width: 0;
    border: 0;
    border-right: 1px solid var(--color-line);
    background: none;
    font-family: inherit;
    cursor: pointer;
    color: var(--color-muted);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 8px 2px 7px;
    transition:
      color 0.12s ease,
      background 0.12s ease;
  }
  .lens:last-child {
    border-right: 0;
  }
  .lens .ic {
    font-size: var(--fs-lg);
    line-height: 1;
  }
  /* Label tracking is the strip's OWN modest 0.02em — deliberately NOT the .micro 0.18em
     uppercase tracking — so width stays predictable for the single-row math. --fs-meta
     (11px) here is a DELIBERATE sub-16px exception (the glyph carries primary meaning and a
     tooltip backs it); ellipsis is a last-resort guard for the very narrowest widths. */
  .lens .lb {
    font-size: var(--fs-meta);
    letter-spacing: 0.02em;
    text-transform: uppercase;
    line-height: 1;
    max-width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .lens:hover {
    color: var(--color-ink);
  }
  .lens.on {
    color: var(--color-amber);
    background: var(--color-inset);
    box-shadow: inset 0 -2px 0 var(--color-amber);
  }
  /* Up Next is the headline "what to start" lens — slightly brighter at rest so it reads as
     the primary entry point (still amber when active, like the others). */
  .lens-next:not(.on) {
    color: var(--color-ink);
  }
  .lens-next:not(.on):hover {
    color: var(--color-amber);
  }
  .lens:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  /* Anchor for the absolutely-positioned owed count badge so it overlays the segment's
     top-right corner without consuming column width (keeps the 6-lens single-row grid intact). */
  .lens-owed {
    position: relative;
  }
  /* Owed count badge (#1257): mirrors UnitRow's .chip-manual-steps recipe (--status-warn border/
     text + color-mix wash). --fs-micro is a deliberate sub-16px exception — same precedent as the
     strip's own label and the UnitRow chip; it's a count overlay, not body text. */
  .owed-badge {
    position: absolute;
    top: 3px;
    right: 3px;
    min-width: 14px;
    box-sizing: border-box;
    text-align: center;
    font-size: var(--fs-micro);
    line-height: 1.2;
    letter-spacing: 0.02em;
    padding: 0 3px;
    border: 1px solid var(--status-warn);
    border-radius: 7px;
    color: var(--status-warn);
    background: color-mix(in oklab, var(--status-warn) 14%, var(--color-panel));
  }
  /* Shrink the label when the strip itself is narrow so the longest DE label ("Nächstes")
     stays on one line and all six lenses keep to a single row at the 300px sidebar floor. */
  @container (max-width: 336px) {
    .lens .lb {
      font-size: 9px;
      letter-spacing: 0;
    }
  }

  /* Status filter chip (top-bar tally), rehomed to a thin row below the strip. */
  .chip-row {
    display: flex;
    padding: 6px 10px;
    border-bottom: 1px solid var(--color-line);
  }
  .statchip {
    border: 0;
    background: none;
    font-family: inherit;
    cursor: pointer;
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-amber);
  }
  .statchip:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
</style>
