<script lang="ts">
  import type {
    DrainStatus,
    Epic,
    EpicChild,
    GitState,
    Session,
    SessionStatus,
  } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { modelOptionLabel } from "#lib/model-guidance.js";
  import { effortLabel } from "#lib/effort-guidance.js";
  import { slotHeldBy, type EpicRunTone } from "../epic-panel";
  import { childPrUrl, childView, openBlockers } from "../epic-child";
  import RunPanel from "./RunPanel.svelte";
  import EpicChildSteps from "./EpicChildSteps.svelte";
  import EpicChildSession from "./EpicChildSession.svelte";

  // The run area of an epic child in the backlog reading detail (#2622) — the same frame as
  // the epic's "Abarbeitung", with the content chosen by the child's state:
  //  - not started → "Stand im Epic": waiting on / up next, the Needs → This → Unlocks steps,
  //    the epic's run settings and a manual "start anyway";
  //  - running / in review → "Sitzung": live status + held slot, phase bar, agent, PR;
  //  - merged → a plain merged state with the PR link.
  let {
    child,
    epic,
    drain = null,
    live = null,
    titleFor,
    onstartanyway = undefined,
    onselectepic = undefined,
    onselectchild = undefined,
    onopensession = undefined,
  }: {
    child: EpicChild;
    /** The child's epic record: its siblings and run settings. */
    epic: Epic;
    drain?: DrainStatus | null;
    /** The child's session and PR state from the store; null when unknown. */
    live?: { session: Session; git?: GitState } | null;
    titleFor: (issue: number) => string | null;
    /** Open the New Task dialog for this child outside the epic's order. */
    onstartanyway?: () => void;
    onselectepic?: () => void;
    onselectchild?: (child: number) => void;
    onopensession?: (sessionId: string) => void;
  } = $props();

  const parent = $derived(epic.parentIssueNumber);
  const view = $derived(childView(child));
  const runSummary = $derived(drain?.runSummary ?? null);
  const blockers = $derived(openBlockers(child, epic.children));

  const STATUS: Record<SessionStatus, () => string> = {
    running: m.childrun_status_running,
    idle: m.childrun_status_idle,
    blocked: m.childrun_status_blocked,
    done: m.childrun_status_done,
    archived: m.childrun_status_archived,
  };

  const state = $derived.by((): { text: string; tone: EpicRunTone; kind: string } => {
    if (view === "merged") return { text: m.childrun_merged(), tone: "quiet", kind: "merged" };
    if (view === "standing") {
      if (blockers.length) {
        const deps = blockers.map((n) => `#${n}`).join(", ");
        return { text: m.childrun_waiting_on({ deps }), tone: "quiet", kind: "waiting" };
      }
      const up = runSummary?.next[0] === child.number;
      return { text: m.childrun_next(), tone: up ? "run" : "quiet", kind: "next" };
    }
    const status = live?.session.status;
    let text = status
      ? STATUS[status]()
      : child.state === "in-review"
        ? m.childrun_state_in_review()
        : m.childrun_state_running();
    const slot = slotHeldBy(runSummary, child.number);
    if (slot) text = m.childrun_holds_slot({ status: text, index: slot.index, max: slot.max });
    const tone: EpicRunTone =
      status === "blocked" ? "halt" : status === "running" || slot ? "run" : "quiet";
    return { text, tone, kind: "session" };
  });

  // "Runs via epic #n · CLI · model · effort" — the settings a drained child spawns with.
  const via = $derived.by(() => {
    const provider = epic.run.agentProvider ?? null;
    const cli = !provider
      ? m.epic_provider_inherit()
      : provider === "codex"
        ? m.agent_provider_codex()
        : m.agent_provider_claude();
    const model = epic.run.model
      ? provider
        ? modelOptionLabel(provider, epic.run.model)
        : epic.run.model
      : m.newtask_model_default();
    const effort = epic.run.effort ? effortLabel(epic.run.effort) : m.effort_default();
    return m.childrun_via({ parent, cli, model, effort });
  });

  const mergedPr = $derived(view === "merged" ? childPrUrl(child) : null);
</script>

<RunPanel
  label={view === "session" ? m.childrun_session_label() : m.childrun_standing_label()}
  stateText={state.text}
  tone={state.tone}
  kind={state.kind}
  data-child-run
>
  {#if view === "standing"}
    <EpicChildSteps {child} siblings={epic.children} {titleFor} {onselectchild} />
    <p class="via">
      {via}
      {#if onselectepic}
        · <button class="link" type="button" onclick={onselectepic}
          >{m.childrun_settings_in_epic()}</button
        >
      {/if}
    </p>
    {#if onstartanyway}
      <button class="gbtn start-anyway" type="button" onclick={onstartanyway}
        >{m.childrun_start_anyway()}</button
      >
    {/if}
  {:else if view === "session"}
    <EpicChildSession {child} {live} {runSummary} {onopensession} />
  {:else if mergedPr}
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
    <a class="pr-link" href={mergedPr} target="_blank" rel="noopener noreferrer"
      >{m.childrun_pr_link({ number: child.prNumber ?? 0 })} ↗</a
    >
  {/if}
</RunPanel>

<style>
  .via {
    margin: 0;
    color: var(--color-faint);
    font-size: var(--fs-micro);
  }

  .pr-link {
    align-self: flex-start;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    text-decoration: none;
  }
  .pr-link:hover {
    color: var(--color-amber);
    text-decoration: underline;
  }

  /* Text-link recipe (as EpicRunSteps' .link). */
  .link {
    padding: 0;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
  .link:hover,
  .link:focus-visible {
    color: var(--color-amber);
    outline: none;
  }

  /* Canonical .gbtn recipe from /design-system (scoped copy, as in EpicRunControl). A
     secondary action, so it sits left under the steps rather than in the head. */
  .gbtn {
    align-self: flex-start;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
  }
  .gbtn:hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  @media (max-width: 768px), (max-height: 600px) {
    .gbtn {
      min-height: 44px;
      padding: 2px 14px;
    }
  }
  @media (max-width: 768px), (pointer: coarse) {
    .link {
      min-height: 32px;
    }
  }
</style>
