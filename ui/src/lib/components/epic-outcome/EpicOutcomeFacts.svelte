<script lang="ts">
  import type { CompletedEpic } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { isSucceededEpic, successStamp, successTime } from "#lib/succeeded-epics.js";

  // #3838: the history's facts of a finished epic — when it completed, and when (if yet) the
  // operator confirmed it; an epic closed without landing names when its sub-tasks were done.
  let { epic }: { epic: CompletedEpic } = $props();
  type Fact = { label: string; at: number | null; missing?: string };
  const facts = $derived<Fact[]>(
    isSucceededEpic(epic)
      ? [
          { label: m.epic_history_completed_label(), at: successTime(epic) },
          {
            label: m.epic_history_confirmed_label(),
            at: epic.acknowledgedAt ?? null,
            missing: m.epic_history_unconfirmed(),
          },
        ]
      : [{ label: m.epic_history_done_label(), at: epic.completedAt }],
  );
</script>

<dl>
  {#each facts as fact (fact.label)}
    <dt>{fact.label}</dt>
    <dd>
      {#if fact.at != null}<time datetime={new Date(fact.at).toISOString()}
          >{successStamp(fact.at)}</time
        >{:else}<span class="missing">{fact.missing}</span>{/if}
    </dd>
  {/each}
</dl>

<style>
  dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 5px 10px;
    margin: 0;
  }
  dt {
    color: var(--color-muted);
  }
  dd {
    margin: 0;
    font-size: var(--fs-micro);
    color: var(--color-ink);
  }
  time {
    font-family: var(--font-mono);
  }
  .missing {
    color: var(--color-muted);
  }
</style>
