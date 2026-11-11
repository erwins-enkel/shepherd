<script lang="ts">
  import type { Session } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";

  import { schedulePauseLabel, formatScheduleTokens } from "#lib/schedules.svelte.js";
  import {
    schedulePauseExplanation,
    scheduleBudgetExplanation,
  } from "#lib/tooltips/explanations.js";

  // A session an operator schedule spawned (#3469). The name is read live, so a deleted schedule
  // falls back to the bare "scheduled" marker.
  let { session, tip = false }: { session: Session; tip?: boolean } = $props();

  const pause = $derived(session.usagePause?.phase === "paused" ? session.usagePause : null);
  const label = $derived(
    pause
      ? pause.reason === "budget"
        ? m.schedules_budget_result({ used: formatScheduleTokens(pause.tokensUsed ?? 0) })
        : schedulePauseLabel(pause.resumeAt)
      : session.scheduleName
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
  <svelte:element
    this={pause ? "button" : "span"}
    type={pause ? "button" : undefined}
    class="schedule-badge"
    role={pause ? undefined : "img"}
    aria-label={label}
    title={tip || pause ? undefined : title}
    use:statusTip={pause
      ? {
          text:
            pause.reason === "budget"
              ? scheduleBudgetExplanation()
              : schedulePauseExplanation(pause.resumeAt),
        }
      : tip
        ? { text: title }
        : null}
  >
    <span class="full">{label}</span>
    <span class="short">{pause ? label : m.schedule_badge_label()}</span>
  </svelte:element>
{/if}

<style>
  button.schedule-badge {
    background: none;
    font-family: inherit;
    line-height: inherit;
    text-align: inherit;
  }

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
