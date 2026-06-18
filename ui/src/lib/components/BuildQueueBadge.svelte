<script lang="ts">
  import { buildQueues } from "$lib/buildQueues.svelte";
  import { m } from "$lib/paraglide/messages";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";

  let { sessionId }: { sessionId: string } = $props();

  const queue = $derived(buildQueues.map[sessionId] ?? null);
  const total = $derived(queue?.steps.length ?? 0);
  const resolved = $derived(
    queue?.steps.filter((s) => s.status === "done" || s.status === "skipped").length ?? 0,
  );
  const pct = $derived(total > 0 ? (resolved / total) * 100 : 0);
</script>

{#if queue?.approved && total > 0}
  <span
    class="queue-badge"
    role="img"
    style="--queue-pct: {pct}%"
    title={m.queuebadge_title({ resolved, total })}
    aria-label={m.queuebadge_aria({ resolved, total })}
    use:coachTarget={"build-queue-progress"}
  >
    <span class="queue-label">{m.queuebadge_label({ resolved, total })}</span>
  </span>
{/if}

<style>
  /* Single-row badge matching its siblings (PREVIEW / REWORK / status badges):
     same outline idiom, same height. Progress is shown as a subtle amber wash
     filling the badge box left→right to --queue-pct (hard-edged gradient stop),
     so there's no extra meter row to make this badge taller than the others. */
  .queue-badge {
    display: inline-flex;
    align-items: center;
    flex: none;
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font-weight: 600;
    padding: 1px 6px;
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    color: var(--color-amber);
    white-space: nowrap;
    overflow: hidden;
    background: linear-gradient(
      to right,
      color-mix(in srgb, var(--color-amber) 22%, transparent) var(--queue-pct),
      transparent var(--queue-pct)
    );
  }
</style>
