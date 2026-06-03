<script lang="ts">
  import type { DrainStatus } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { basename } from "./learnings-drawer";
  import { enabledDrains, pausedText } from "./queue-strip";

  let { drain }: { drain: Record<string, DrainStatus> } = $props();

  const rows = $derived(enabledDrains(drain));
</script>

{#if rows.length > 0}
  <div class="queue-strip" role="status" aria-label={m.drain_strip_label()}>
    <span class="qs-label">🚰 {m.drain_strip_label()}</span>
    <ul class="qs-rows">
      {#each rows as d (d.repoPath)}
        <li class="qs-row" class:paused={d.paused}>
          <span class="qs-repo">{basename(d.repoPath)}</span>
          <span class="qs-inflight">{m.drain_inflight({ count: d.inFlight, max: d.max })}</span>
          <span class="qs-queued">{m.drain_queued({ count: d.queued })}</span>
          {#if d.paused}
            <span class="qs-pause" title={pausedText(d)}>{pausedText(d)}</span>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .queue-strip {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 5px 10px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-panel);
    font-family: var(--font-mono);
  }
  .qs-label {
    font-size: 9.5px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .qs-rows {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 14px;
    margin: 0;
    padding: 0;
    list-style: none;
    min-width: 0;
  }
  .qs-row {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
    white-space: nowrap;
  }
  .qs-repo {
    color: var(--color-ink-bright);
    font-weight: 500;
  }
  .qs-inflight {
    color: var(--color-ink);
    font-variant-numeric: tabular-nums;
  }
  .qs-queued {
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }
  /* a paused drain is the loud thing in the band: red, with its reason inline */
  .qs-pause {
    color: var(--color-red);
    background: color-mix(in oklab, var(--color-red) 12%, transparent);
    padding: 1px 6px;
    border-radius: 2px;
    text-transform: none;
    letter-spacing: 0.04em;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 320px;
  }
</style>
