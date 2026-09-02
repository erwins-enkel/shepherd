<script lang="ts">
  import type { HerdFilter } from "$lib/components/herd-partition";
  import { m } from "$lib/paraglide/messages";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";

  let {
    filter = $bindable<HerdFilter>(),
    statusFilter,
    onstatusfilter,
  }: {
    filter: HerdFilter;
    statusFilter: "running" | "idle" | "blocked" | null;
    onstatusfilter?: (status: "running" | "idle" | "blocked" | null) => void;
  } = $props();
</script>

<!-- Mobile-only segmented control: replaces the .fbtn filter row in flow
     mode. A direct child of the already-full-bleed .panel.flow, so it spans
     the full phone width without its own negative margin. Five equal-width
     segments (#1198 added Owed; the Rundown segment was later removed), 44px
     touch targets, no leading glyphs. Labels are --fs-meta (11px), a DELIBERATE
     exception to the ≥16px label floor (NOT an oversight): the binding width is
     no longer the 390px reference — five segments there leave ~78px each (~73px
     content after padding/border), enough for the longest label ("Nächstes", DE,
     ~67px at 13px). It binds on SMALL phones and fold covers: at ~320px five
     segments give ~64px each (~59px content), where that same label truncates
     at 13px but fits at 11px (~57px). Kept at 11px for that floor and to match
     the desktop HerdLensStrip's --fs-meta labels; contrast is held high to
     compensate (active --color-amber 8.49:1, inactive --color-muted 5.27:1,
     both > 4.5:1 AA). -->
<div class="seg-row" use:coachTarget={"mobile-seg-ctrl"}>
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
    class:seg-active={statusFilter == null && filter === "done"}
    title={m.herd_done_title()}
    aria-pressed={statusFilter == null && filter === "done"}
    onclick={() => {
      filter = "done";
      onstatusfilter?.(null);
    }}>{m.herd_seg_done()}</button
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
  /* Mobile-only segmented control: replaces the .fbtn filter row in flow mode.
     A direct child of the already-full-bleed .panel.flow, so it spans the full
     phone width without its own negative margin. Five equal-width segments (#1198
     added Owed; the Rundown segment was later removed), 44px touch targets.
     Labels are --fs-meta (11px) — a DELIBERATE sub-16px exception, not an
     oversight. The 390px reference no longer binds: five segments give ~78px each
     (~73px content), which fits "Nächstes" (DE, ~67px at 13px). The exception
     earns its place on small phones / fold covers — at ~320px five segments give
     ~64px each (~59px content), where that label truncates at 13px but fits at
     11px (~57px). The ≥16px floor is waived for this one control to keep full
     text labels (matching the desktop HerdLensStrip's 11px labels); high contrast
     (amber active / muted inactive) compensates. A text-overflow:ellipsis below
     handles anything narrower still. */
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
  .seg-btn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
</style>
