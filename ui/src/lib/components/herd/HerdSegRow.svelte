<script lang="ts">
  import type { HerdFilter } from "$lib/components/herd-partition";
  import { m } from "$lib/paraglide/messages";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";

  let {
    filter = $bindable<HerdFilter>(),
    statusFilter,
    onstatusfilter,
    placement = "top",
  }: {
    filter: HerdFilter;
    statusFilter: "running" | "idle" | "blocked" | null;
    onstatusfilter?: (status: "running" | "idle" | "blocked" | null) => void;
    /** Which edge carries the active marker. The row lives in the bottom navigation on a
     *  phone (D10, docs/design/mobile-herd), where an underline would sit against the screen
     *  edge and read as detached — so the marker moves to the top edge there. */
    placement?: "top" | "bottom";
  } = $props();
</script>

<!-- Mobile-only segmented control. It lives in the BOTTOM navigation bar (ActionBar) on a
     phone, not at the top of the herd panel — everything the operator taps sits in the thumb
     zone (D10, docs/design/mobile-herd).

     FOUR equal-width segments. The Done lens deliberately has none: its entry moved to the gear
     menu (D11), which is what freed the width for REPOS and "New task" to share this one bar
     instead of needing a second. Labels are --fs-meta (11px) — a DELIBERATE sub-16px exception.
     Note that its ORIGINAL justification (five segments squeezing a fold cover) no longer binds:
     four segments give ~102px each at 430px and ~75px at 320px, and "Nächstes" (DE, the longest
     label) needs ~67px at 13px. The 11px now stands on the remaining reason alone — matching the
     desktop HerdLensStrip's --fs-meta labels so the two lens controls read as one thing — with
     contrast held high to compensate (active --color-amber 8.49:1, inactive --color-muted 5.27:1,
     both > 4.5:1 AA). -->
<div
  class="seg-row"
  class:seg-row--bottom={placement === "bottom"}
  use:coachTarget={"mobile-seg-ctrl"}
>
  <button
    type="button"
    class="seg-btn"
    class:seg-active={statusFilter == null && filter === "next"}
    title={m.herd_next_title()}
    aria-pressed={statusFilter == null && filter === "next"}
    use:coachTarget={"up-next-lens"}
    onclick={() => {
      filter = "next";
      onstatusfilter?.(null);
    }}>{m.herd_seg_next()}</button
  >
  <button
    type="button"
    class="seg-btn"
    class:seg-active={statusFilter == null && filter === "all"}
    title={m.herd_all_title()}
    aria-pressed={statusFilter == null && filter === "all"}
    onclick={() => {
      filter = "all";
      onstatusfilter?.(null);
    }}>{m.herd_seg_all()}</button
  >
  <button
    type="button"
    class="seg-btn"
    class:seg-active={statusFilter == null && filter === "ready"}
    title={m.herd_ready_title()}
    aria-pressed={statusFilter == null && filter === "ready"}
    onclick={() => {
      filter = "ready";
      onstatusfilter?.(null);
    }}>{m.herd_seg_ready()}</button
  >
  <button
    type="button"
    class="seg-btn"
    class:seg-active={statusFilter == null && filter === "owed"}
    title={m.herd_owed_title()}
    aria-pressed={statusFilter == null && filter === "owed"}
    use:coachTarget={"owed-lens"}
    onclick={() => {
      filter = "owed";
      onstatusfilter?.(null);
    }}>{m.herd_seg_owed()}</button
  >
</div>

<style>
  /* Mobile-only segmented control; see the template comment above for why it is four segments
     and why the labels stay at --fs-meta. Full-bleed inside its bar, 44px touch targets. A
     text-overflow:ellipsis below handles anything narrower than a fold cover. */
  .seg-row {
    display: flex;
    border-bottom: 1px solid var(--color-line);
  }
  .seg-btn {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    border: 0;
    border-right: 1px solid var(--color-line);
    background: none;
    font-family: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
    padding: 0 2px;
    color: var(--color-muted);
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition:
      color 0.12s ease,
      background 0.12s ease;
  }
  .seg-btn:last-child {
    border-right: 0;
  }
  .seg-btn:hover {
    color: var(--color-ink);
  }
  .seg-btn.seg-active {
    color: var(--color-amber);
    background: var(--color-inset);
    box-shadow: inset 0 -2px 0 var(--color-amber);
  }
  /* Bottom navigation (D10): the marker moves to the top edge, where it separates the active
     segment from the list above instead of hugging the screen edge below. */
  .seg-row--bottom {
    border-bottom: 0;
  }
  .seg-row--bottom .seg-btn.seg-active {
    box-shadow: inset 0 2px 0 var(--color-amber);
  }
  .seg-btn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
</style>
