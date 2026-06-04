<script lang="ts">
  import { formatAgo, heartbeatTone } from "$lib/format";
  import { m } from "$lib/paraglide/messages";
  import type { SessionActivity } from "$lib/types";

  let { activity, nowMs }: { activity?: SessionActivity; nowMs: number } = $props();

  const delta = $derived(nowMs - (activity?.lastActivityTs ?? 0));
  const tone = $derived(heartbeatTone(delta));
</script>

{#if !activity}
  <span class="hb starting">{m.activity_starting()}</span>
{:else if activity.lastActivityTs > 0}
  <span class="hb {tone}">
    <span class="dot" aria-hidden="true"></span>{m.activity_active({ ago: formatAgo(delta) })}
  </span>
{:else}
  <!-- signal present but timestamp-less (transcript edge) — quiet dot only; the
       summary line carries the detail, so no "starting…" text or "ago". -->
  <span class="hb live">
    <span class="dot" aria-hidden="true"></span>
  </span>
{/if}

<style>
  .hb {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    line-height: 1;
    white-space: nowrap;
    color: var(--color-muted);
  }
  .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
    flex: none;
  }
  /* Cosmetic freshness only — no motion (StatusPip already pulses). live = brightest,
     stale = faint. Matches StatusPip's CSS-var palette. */
  .hb.live {
    color: var(--status-running);
  }
  .hb.recent {
    color: var(--color-muted);
  }
  .hb.stale,
  .hb.starting {
    color: var(--color-faint);
  }
</style>
