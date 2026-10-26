<script lang="ts">
  import type { Session } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";

  // A session an operator schedule spawned (#3469). The name is read live, so a deleted schedule
  // falls back to the bare "scheduled" marker.
  let { session, tip = false }: { session: Session; tip?: boolean } = $props();

  const label = $derived(
    session.scheduleName
      ? m.schedule_badge_label_named({ name: session.scheduleName })
      : m.schedule_badge_label(),
  );
</script>

{#if session.scheduleId}
  <span
    class="schedule-badge"
    role="img"
    aria-label={label}
    title={tip ? undefined : m.schedule_badge_title()}
    use:statusTip={tip ? { text: m.schedule_badge_title() } : null}
  >
    {label}
  </span>
{/if}

<style>
  /* Quiet kind-marker, same slate "noted info" tier as ResearchBadge. */
  .schedule-badge {
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--color-slate);
    border-radius: 2px;
    color: var(--color-slate);
    white-space: nowrap;
    max-width: 18ch;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 600;
  }
</style>
