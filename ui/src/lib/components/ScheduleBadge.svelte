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
  const title = $derived(
    session.scheduleName
      ? m.schedule_badge_title_named({ name: session.scheduleName })
      : m.schedule_badge_title(),
  );
</script>

{#if session.scheduleId}
  <span
    class="schedule-badge"
    role="img"
    aria-label={label}
    title={tip ? undefined : title}
    use:statusTip={tip ? { text: title } : null}
  >
    <span class="full">{label}</span>
    <span class="short">{m.schedule_badge_label()}</span>
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
    font-weight: 600;
    /* A flex item in the strip: lets a narrow strip shrink it so .full can ellipsize. */
    min-width: 0;
  }
  .full {
    display: block;
    max-width: 36ch;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .short {
    display: none;
  }
  /* The phone rail takes its width from the prompt, so the name stays in the tooltip there. */
  :global(.units.flow) .full {
    display: none;
  }
  :global(.units.flow) .short {
    display: inline;
  }
</style>
