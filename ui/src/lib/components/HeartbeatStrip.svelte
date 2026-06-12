<script lang="ts">
  import { formatAgo } from "$lib/format";
  import { bucketStrip } from "$lib/heartbeat";
  import { m } from "$lib/paraglide/messages";
  import type { SessionActivity } from "$lib/types";

  let { activity, nowMs }: { activity?: SessionActivity; nowMs: number } = $props();

  // Bucket against nowMs (not the server's push time) so the strip ages/drains live.
  const cells = $derived(bucketStrip(activity?.recentTs ?? [], activity?.recentErrTs ?? [], nowMs));

  // Screen-reader text: reuse the existing recency phrasing; "starting" before the first beat.
  const label = $derived(
    activity && activity.lastActivityTs > 0
      ? m.activity_active({ ago: formatAgo(nowMs - activity.lastActivityTs) })
      : m.activity_starting(),
  );
</script>

<span class="strip" role="img" aria-label={label}>
  {#each cells as cell, i (i)}
    <span
      class="cell"
      class:err={cell.error}
      class:now={cell.now}
      data-level={cell.level}
      aria-hidden="true"
    ></span>
  {/each}
</span>

<style>
  /* 24 equal cells; amber (--status-running) for live/recent signal (level ≥ 2
     and .now); low-activity cells (level 0–1) render neutral faint ink so idle
     strips read grey, not orange — amber is reserved for genuine "alive" signal.
     No motion — StatusPip already pulses (matches prior Heartbeat.svelte decision). */
  .strip {
    display: inline-flex;
    align-items: stretch;
    gap: 1px;
    width: 132px;
    max-width: 40vw;
    height: 12px;
    flex: none;
  }
  .cell {
    flex: 1 1 0;
    border-radius: 1px;
    background: currentColor;
    /* faint neutral track by default; live cells (level ≥ 2 / now) re-set amber below */
    color: var(--color-faint);
    opacity: 0.12; /* level 0 = faint empty track */
  }
  .cell[data-level="1"] {
    color: var(--color-faint);
    opacity: 0.35;
  }
  /* level ≥ 2 is genuine activity — restore amber over the faint base so the
     live signal still glows while the empty track + trickle stay grey. */
  .cell[data-level="2"] {
    color: var(--status-running);
    opacity: 0.6;
  }
  .cell[data-level="3"] {
    color: var(--status-running);
    opacity: 0.82;
  }
  .cell[data-level="4"] {
    color: var(--status-running);
    opacity: 1;
  }
  .cell.now {
    color: var(--status-running);
    opacity: 1;
  }
  /* an errored slice (always level ≥ 1) renders red instead of amber. A
     non-color cue rides alongside the hue (WCAG 1.4.1): the cell is rendered
     as a shorter bottom-anchored stub (~55% of full height), so an error reads
     as a "dropped" bar with a gap along the top edge of the strip. This
     silhouette difference remains perceptible even at ~1.7px cell width
     (collapsed strip in UnitRow) because it is an edge/outline difference, not
     an interior detail, and it does not collide with the opacity-based recency
     encoding (every normal cell is full height regardless of level). */
  .cell.err {
    color: var(--color-red);
    opacity: 0.85;
    align-self: flex-end;
    height: 55%;
  }
</style>
