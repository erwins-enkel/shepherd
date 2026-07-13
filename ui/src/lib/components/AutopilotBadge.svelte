<script lang="ts">
  import type { Session } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { codexAutopilotUnavailable } from "$lib/format";
  import { statusTip } from "$lib/actions/statusTip.svelte";

  // `tip` (Herd card only): swap the native title for the styled statusTip tooltip.
  let {
    session,
    repoAutopilotDefault,
    tip = false,
  }: { session: Session; repoAutopilotDefault: boolean; tip?: boolean } = $props();

  const pausedTitle = $derived(
    m.session_autopilot_paused_title({ question: session.autopilotQuestion ?? "" }),
  );
  const completeTitle = $derived(
    m.session_autopilot_complete_title({ summary: session.autopilotQuestion ?? "" }),
  );
</script>

<!-- Keep in sync with autopilotBadgeShown() in $lib/format — both must list the same states or card status-badge suppression desyncs. -->
{#if session.autopilotPaused}
  <span
    class="ap-paused"
    title={tip ? undefined : pausedTitle}
    use:statusTip={tip ? { text: pausedTitle } : null}
    role="img"
    aria-label={m.session_autopilot_paused_label()}
  >
    {m.session_autopilot_paused_label()}
  </span>
{:else if session.autopilotComplete}
  <span
    class="ap-complete"
    title={tip ? undefined : completeTitle}
    use:statusTip={tip ? { text: completeTitle } : null}
    role="img"
    aria-label={m.session_autopilot_complete_label()}
  >
    {m.session_autopilot_complete_label()}
  </span>
{:else if codexAutopilotUnavailable(session, repoAutopilotDefault)}
  <span
    class="ap-unavailable"
    title={tip ? undefined : m.session_autopilot_unavailable_title()}
    use:statusTip={tip ? { text: m.session_autopilot_unavailable_title() } : null}
    role="img"
    aria-label={m.session_autopilot_unavailable_label()}
  >
    {m.session_autopilot_unavailable_label()}
  </span>
{/if}

<style>
  .ap-paused,
  .ap-complete,
  .ap-unavailable {
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    color: var(--color-amber);
    white-space: nowrap;
    font-weight: 600;
  }
  .ap-complete {
    border-color: var(--color-green);
    color: var(--color-green);
  }
  .ap-unavailable {
    border-color: var(--color-slate);
    color: var(--color-slate);
  }
</style>
