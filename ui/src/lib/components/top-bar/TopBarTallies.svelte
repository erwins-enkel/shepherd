<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";

  export type TallyStatus = "running" | "idle" | "blocked";

  let {
    mobile,
    compact = false,
    total,
    working,
    idle,
    blocked,
    statusFilter,
    onstatusfilter,
    clickStatus,
  }: {
    mobile: boolean;
    /** Collapse to the dot+digit form under measured overflow (desktop AND touch-desktop /
     *  the unfolded fold) — the same compact form phones get from `mobile`. Matches the
     *  sibling NEEDS-YOU / held badges, which also compact on the measured-overflow signal. */
    compact?: boolean;
    total: number;
    working: number;
    idle: number;
    blocked: number;
    statusFilter: TallyStatus | null;
    onstatusfilter?: (status: TallyStatus | null) => void;
    clickStatus: (s: TallyStatus) => void;
  } = $props();
</script>

{#if mobile || compact}
  <div class="tallies compact">
    <!-- aria-labels carry the COUNT alongside the action (the visible text is a
         bare digit, and an action-only label would hide the tally from screen
         readers — the desktop buttons get this for free from their text content) -->
    <button
      type="button"
      class="ctally"
      disabled={statusFilter == null}
      title={m.topbar_tally_clear_title()}
      aria-label={m.topbar_tally_total_aria({ count: total })}
      onclick={() => onstatusfilter?.(null)}
    >
      <span class="n">{total}</span>
    </button>
    <button
      type="button"
      class="ctally"
      class:active={statusFilter === "running"}
      title={m.topbar_tally_filter_title({ status: m.topbar_working_label() })}
      aria-label={m.topbar_tally_status_aria({
        status: m.topbar_working_label(),
        count: working,
      })}
      aria-pressed={statusFilter === "running"}
      onclick={() => clickStatus("running")}
    >
      <span class="cdot" style="color:var(--color-amber)">●</span><span class="n">{working}</span>
    </button>
    <span class="csep">·</span>
    <button
      type="button"
      class="ctally"
      class:active={statusFilter === "idle"}
      title={m.topbar_tally_filter_title({ status: m.topbar_idle_label() })}
      aria-label={m.topbar_tally_status_aria({ status: m.topbar_idle_label(), count: idle })}
      aria-pressed={statusFilter === "idle"}
      onclick={() => clickStatus("idle")}
    >
      <span class="n">{idle}</span>
    </button>
    <button
      type="button"
      class="ctally"
      class:active={statusFilter === "blocked"}
      title={m.topbar_tally_filter_title({ status: m.topbar_blocked_label() })}
      aria-label={m.topbar_tally_status_aria({
        status: m.topbar_blocked_label(),
        count: blocked,
      })}
      aria-pressed={statusFilter === "blocked"}
      onclick={() => clickStatus("blocked")}
    >
      <span class="cdot" style="color:var(--color-red)">!</span><span class="n">{blocked}</span>
    </button>
  </div>
{:else}
  <div class="tallies" use:coachTarget={"tally-filter"}>
    <!-- the total is a CLEAR action — without an active filter it's a no-op, so
         it renders disabled (no hover/click affordance) until a status is set -->
    <button
      type="button"
      class="tally"
      disabled={statusFilter == null}
      title={m.topbar_tally_clear_title()}
      onclick={() => onstatusfilter?.(null)}
    >
      <span class="micro">{m.topbar_herd_label()}</span><span class="n">{total}</span>
    </button>
    <button
      type="button"
      class="tally"
      class:active={statusFilter === "running"}
      title={m.topbar_tally_filter_title({ status: m.topbar_working_label() })}
      aria-pressed={statusFilter === "running"}
      onclick={() => clickStatus("running")}
    >
      <span class="micro" style="color:var(--color-amber)">{m.topbar_working_label()}</span><span
        class="n">{working}</span
      >
    </button>
    <button
      type="button"
      class="tally"
      class:active={statusFilter === "idle"}
      title={m.topbar_tally_filter_title({ status: m.topbar_idle_label() })}
      aria-pressed={statusFilter === "idle"}
      onclick={() => clickStatus("idle")}
    >
      <span class="micro">{m.topbar_idle_label()}</span><span class="n">{idle}</span>
    </button>
    <button
      type="button"
      class="tally"
      class:active={statusFilter === "blocked"}
      title={m.topbar_tally_filter_title({ status: m.topbar_blocked_label() })}
      aria-pressed={statusFilter === "blocked"}
      onclick={() => clickStatus("blocked")}
    >
      <span class="micro" style="color:var(--color-red)">{m.topbar_blocked_label()}</span><span
        class="n">{blocked}</span
      >
    </button>
  </div>
{/if}

<style>
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .tallies {
    display: flex;
    /* was 18px between static divs: the tally buttons now carry 4px side padding
       each, so 10px gap keeps the content-to-content rhythm (4+10+4) and the bar's
       intrinsic width ~stable — the measured desktop compaction threshold
       (hudEl.scrollWidth) must not drift */
    gap: 10px;
    align-items: center;
  }
  .tally {
    box-sizing: border-box;
    display: flex;
    gap: 7px;
    align-items: center;
    /* shared bar control height (matches the right cluster); box-sizing keeps the
       rendered box at exactly --topbar-ctl-h despite the 1px border, and the text
       centers via align-items instead of vertical padding driving the height */
    min-height: var(--topbar-ctl-h);
    line-height: 1;
    background: none;
    border: 1px solid transparent;
    /* horizontal-only: vertical padding no longer drives height. Side padding stays
       4px so the full-label width — what the measured compaction threshold reads — is
       unchanged */
    padding: 0 4px;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }
  .tally:not(:disabled):hover {
    background: var(--color-inset);
  }
  /* the disabled total (no active filter → clearing is a no-op) keeps its full
     tally appearance, just without the click affordance */
  .tally:disabled,
  .ctally:disabled {
    cursor: default;
  }
  .tally.active {
    background: var(--color-inset);
    border-color: var(--color-line-bright);
  }
  .tally .n {
    color: var(--color-ink-bright);
    font-weight: 500;
  }
  .tallies.compact {
    display: flex;
    align-items: center;
    /* button side padding (5px) now provides the separation the old 4px gap gave */
    gap: 0;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
  .ctally {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    background: none;
    border: 1px solid transparent;
    padding: 0 5px;
    line-height: 1;
    font: inherit;
    color: inherit;
    cursor: pointer;
    /* HEIGHT: shares the bar's --topbar-ctl-h so the compact tallies sit flush with the
       right cluster (#1131). box-sizing makes that a true 30px box despite the 1px
       border; 30px > the 24px WCAG 2.5.8 (AA) target minimum, so the AA height floor is
       still met. WIDTH: min-inline-size keeps the 24px AA target floor on the narrow
       axis — now a true 24px border-box width (content-box previously inflated it to
       ~36px). A 44px WIDTH floor for four buttons would blow the ~260px usable line-1
       budget on fold-cover phones, so width stays at the 24px floor. */
    min-height: var(--topbar-ctl-h);
    min-inline-size: 24px;
  }
  /* Coarse-pointer touch floor: 44px height (matches .hud.mobile .gear/.needsyou).
     With box-sizing:border-box above this renders a true 44px box (was ~46px content-box)
     and still overrides the 30px shared height since 44 > 30. */
  @media (pointer: coarse) {
    .ctally {
      min-height: 44px;
    }
  }
  .ctally.active {
    background: var(--color-inset);
    border-color: var(--color-line-bright);
  }
  .tallies.compact .cdot {
    font-size: var(--fs-micro);
  }
  .tallies.compact .csep {
    color: var(--color-faint);
  }
</style>
