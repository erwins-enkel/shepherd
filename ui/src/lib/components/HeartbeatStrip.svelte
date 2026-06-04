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
  /* 24 equal cells; intensity via opacity on currentColor, so it follows the
     theme's running-green. No motion — StatusPip already pulses (matches the
     prior Heartbeat.svelte decision). */
  .strip {
    display: inline-flex;
    align-items: stretch;
    gap: 1px;
    width: 132px;
    max-width: 40vw;
    height: 12px;
    flex: none;
    color: var(--status-running);
  }
  .cell {
    flex: 1 1 0;
    border-radius: 1px;
    background: currentColor;
    opacity: 0.12; /* level 0 = faint empty track */
  }
  .cell[data-level="1"] {
    opacity: 0.35;
  }
  .cell[data-level="2"] {
    opacity: 0.6;
  }
  .cell[data-level="3"] {
    opacity: 0.82;
  }
  .cell[data-level="4"] {
    opacity: 1;
  }
  .cell.now {
    opacity: 1;
  }
  /* an errored slice (always level ≥ 1) renders red instead of green */
  .cell.err {
    color: var(--color-red);
    opacity: 0.85;
  }
</style>
