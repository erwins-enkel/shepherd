<script lang="ts">
  import type { HerdFilter } from "#lib/components/herd-partition.js";
  import { lensGlyph } from "#lib/components/herd/lens-glyphs.js";
  import { m } from "#lib/paraglide/messages.js";
  import { coachTarget } from "#lib/actions/coachTarget.svelte.js";
  import { upNext } from "#lib/up-next.svelte.js";
  import { readyPrCount } from "#lib/components/up-next-prs.js";

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

  // Bound the badge width so a large count can't perturb the fixed 5-lens single-row grid.
  const owedBadge = $derived(owedCount > 99 ? "99+" : String(owedCount));
  // PRs that can merge right now (server-classified), on the Up Next lens.
  const readyCount = $derived(readyPrCount(upNext.snapshot?.pullRequests));
</script>

<!-- Desktop / touch-wide lens strip: replaces the inline .fbtn filter row that overflowed
     the ~300–360px sidebar header. Icon-over-label segments, full-bleed so it spans the
     panel width and becomes its top edge (the "The Herd" title is dropped). The decorative
     glyph is aria-hidden, so each segment's accessible name is its label alone. The strip
     sets its OWN container (container-type: inline-size) — the `herd` container lives on the
     sibling .units subtree and is unreachable here — so a @container query can shrink the
     label font at narrow widths, keeping full labels legible below the 300px floor.
     The status chip (top-bar tally), which the old inline row carried, is rehomed to a thin
     row below the strip; the touch-wide collapse control is a trailing cell of the strip's row. -->
<div class="lens-row">
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
      <span class="ic" aria-hidden="true">{lensGlyph.next}</span>
      <span class="lb">{m.herd_seg_next()}</span>
      {#if readyCount > 0}
        <span class="ready-badge" aria-label={m.upnext_pr_ready_badge({ count: readyCount })}
          >{readyCount > 99 ? "99+" : readyCount}</span
        >
      {/if}
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
      <span class="ic" aria-hidden="true">{lensGlyph.all}</span>
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
      <span class="ic" aria-hidden="true">{lensGlyph.ready}</span>
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
      <span class="ic" aria-hidden="true">{lensGlyph.done}</span>
      <span class="lb">{m.herd_seg_done()}</span>
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
      <span class="ic" aria-hidden="true">{lensGlyph.owed}</span>
      <span class="lb">{m.herd_seg_owed()}</span>
      {#if owedCount > 0}
        <span class="owed-badge" aria-label={m.herd_owed_count({ count: owedCount })}
          >{owedBadge}</span
        >
      {/if}
    </button>
  </div>
  {#if collapsible}
    <!-- Touch-wide-only collapse control: a trailing cell on the lens row (not a lens, so it sits
       outside the lens group) rather than a row of its own, which cost the column ~24px. -->
    <button
      id="herd-collapse-btn"
      type="button"
      class="collapse-inline"
      title={m.herd_collapse()}
      aria-label={m.herd_collapse()}
      onclick={() => oncollapse?.()}>‹</button
    >
  {/if}
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
  /* The strip and the touch-wide collapse cell share one row and one bottom hairline. */
  .lens-row {
    display: flex;
    border-bottom: 1px solid var(--color-line);
  }
  .collapse-inline {
    flex: none;
    width: 32px;
    border: 0;
    border-left: 1px solid var(--color-line);
    background: none;
    color: var(--color-muted);
    cursor: pointer;
    font-family: inherit;
    font-size: var(--fs-lg);
    line-height: 1;
    padding: 0;
    transition: color 0.12s ease;
  }
  .collapse-inline:hover {
    color: var(--color-ink);
  }
  .collapse-inline:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  .lens-strip {
    /* own container so the label-shrink @container query below can fire (the `herd`
       container is on the sibling .units subtree, unreachable from here) */
    container-type: inline-size;
    display: grid;
    /* five lenses on one row down to the 300px sidebar floor (5×44=220 ≤ inner width);
       wraps only well below that floor (<220) */
    grid-template-columns: repeat(auto-fit, minmax(44px, 1fr));
    flex: 1;
    min-width: 0;
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
     top-right corner without consuming column width (keeps the 5-lens single-row grid intact). */
  .lens-owed,
  .lens-next {
    position: relative;
  }
  /* Owed count badge (#1257): mirrors UnitRow's .chip-manual-steps recipe (--status-warn border/
     text + color-mix wash). --fs-micro is a deliberate sub-16px exception — same precedent as the
     strip's own label and the UnitRow chip; it's a count overlay, not body text. */
  .owed-badge,
  .ready-badge {
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
  /* Up Next's count of PRs ready to merge: the owed badge's recipe in green (actionable). */
  .ready-badge {
    border-color: var(--color-green);
    color: var(--color-green);
    background: color-mix(in oklab, var(--color-green) 14%, var(--color-panel));
  }
  /* Shrink the label when the strip itself is narrow so the longest DE label ("Nächstes")
     stays on one line. Headroom, not load-bearing at the 300px floor: five lenses leave ~60px
     per segment there and the DE labels already fit unshrunk (verified by disabling this
     query — the browser test's no-clip assertion still passed). It earns its place only
     below that floor, so keep it when retuning the minmax() track. */
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
