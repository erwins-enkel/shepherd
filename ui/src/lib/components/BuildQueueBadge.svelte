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
    <span class="queue-meter" aria-hidden="true"><span class="queue-fill"></span></span>
  </span>
{/if}

<style>
  .queue-badge {
    display: inline-flex;
    flex-direction: column;
    flex: none;
    gap: 2px;
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font-weight: 600;
    padding: 1px 6px;
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    color: var(--color-amber);
    background: transparent;
    white-space: nowrap;
  }
  .queue-meter {
    display: block;
    height: 2px;
    width: 100%;
    background: var(--color-line);
    border-radius: 2px;
    overflow: hidden;
  }
  .queue-fill {
    display: block;
    height: 100%;
    width: var(--queue-pct);
    background: var(--color-amber);
  }
</style>
