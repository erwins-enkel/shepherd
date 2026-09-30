<script lang="ts">
  import type { DrainStatus, Epic, EpicSummary, Issue } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import {
    epicRole,
    epicRunState,
    epicRunStateLabel,
    epicRunSteps,
    type EpicRunTone,
  } from "../epic-panel";
  import { epicKey, singleKey } from "../issues-panel";
  import RunPanel from "./RunPanel.svelte";
  import EpicRunSteps from "./EpicRunSteps.svelte";
  import EpicRoleBadge from "./EpicRoleBadge.svelte";

  // The reading detail with nothing selected (#2622): what is happening in this repo. The run
  // area "Abarbeitung im Repo" (which epic leads, its Now → Next → After steps, epics winding
  // down, the agent-slot cap), then every epic with its role and progress, then a short list
  // of the single issues. Entries select themselves in the list.
  const SINGLES_SHOWN = 5;

  let {
    repoName,
    epics,
    singles,
    drain = null,
    leadingRecord = undefined,
    titleFor,
    onselect,
    onopensession = undefined,
    onopenautomation = undefined,
  }: {
    repoName: string;
    /** The repo's epics, in list order. */
    epics: readonly EpicSummary[];
    /** Open issues that are neither an epic nor one's sub-issue. */
    singles: readonly Issue[];
    drain?: DrainStatus | null;
    /** The leading epic's record; undefined while it loads (or when no epic leads). */
    leadingRecord?: Epic;
    titleFor: (issue: number) => string | null;
    /** Select a list entry by its row key. */
    onselect: (key: string) => void;
    onopensession?: (sessionId: string) => void;
    onopenautomation?: () => void;
  } = $props();

  const summary = $derived(drain?.runSummary ?? null);
  const leading = $derived(summary?.leadingEpic ?? null);
  const record = $derived(
    leading != null && leadingRecord?.parentIssueNumber === leading ? leadingRecord : undefined,
  );
  const steps = $derived(record && leading != null ? epicRunSteps(record, leading, drain) : null);

  const state = $derived.by((): { text: string; tone: EpicRunTone } => {
    if (leading == null) {
      return {
        text: m.repooverview_none_leading(),
        tone: summary && summary.slots.used > 0 ? "run" : "quiet",
      };
    }
    if (!record) return { text: m.repooverview_leading_only({ epic: leading }), tone: "run" };
    const run = epicRunState(record, leading, drain);
    const inflight = run.inFlight.map((n) => `#${n}`).join(", ") || "…";
    return {
      text: m.repooverview_leading({ epic: leading, state: epicRunStateLabel(run.kind, inflight) }),
      tone: run.tone,
    };
  });

  // Leading and winding-down epics first, the rest in list order.
  const cards = $derived(
    epics
      .map((e) => ({ epic: e, role: epicRole(summary, e.parentIssueNumber) }))
      .sort((a, b) => rank(a.role) - rank(b.role)),
  );
  function rank(role: ReturnType<typeof epicRole>): number {
    return role === "leading" ? 0 : role === "winding" ? 1 : 2;
  }

  const shownSingles = $derived(singles.slice(0, SINGLES_SHOWN));
</script>

<article class="overview" aria-label={m.repooverview_title({ repo: repoName })}>
  <h2 class="title">{m.repooverview_title({ repo: repoName })}</h2>

  <RunPanel
    label={m.repooverview_run_label()}
    stateText={state.text}
    tone={state.tone}
    data-repo-run
  >
    {#snippet actions()}
      {#if onopenautomation}
        <button class="gbtn" type="button" onclick={onopenautomation}
          >{m.repooverview_change_slots()}</button
        >
      {/if}
    {/snippet}

    {#if steps}
      <EpicRunSteps {steps} {titleFor} {onopensession} />
    {/if}
    {#each summary?.windingDown ?? [] as w (w.epic)}
      <p class="note">
        {m.repooverview_winding({
          epic: w.epic,
          inflight: w.inFlight.map((n) => `#${n}`).join(", "),
        })}
      </p>
    {/each}
    <p class="note">{m.repooverview_hint()}</p>
  </RunPanel>

  {#if cards.length}
    <section class="group" aria-label={m.repooverview_epics()}>
      <h3 class="group-head">{m.repooverview_epics()}</h3>
      <ul class="cards">
        {#each cards as { epic, role } (epic.parentIssueNumber)}
          <li>
            <button
              class="card"
              type="button"
              onclick={() => onselect(epicKey(epic.parentIssueNumber))}
            >
              <span class="line">
                <span class="num">#{epic.parentIssueNumber}</span>
                {#if role}<EpicRoleBadge {role} />{/if}
                <span class="faint"
                  >{m.repooverview_progress({ merged: epic.merged, total: epic.total })}</span
                >
              </span>
              <span class="card-title">{epic.parentTitle}</span>
              <span class="bar" aria-hidden="true"
                ><span
                  class="fill"
                  style:width="{epic.total ? (epic.merged / epic.total) * 100 : 0}%"
                ></span></span
              >
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if singles.length}
    <section class="group" aria-label={m.repooverview_issues()}>
      <h3 class="group-head">{m.repooverview_issues()}</h3>
      <ul class="singles">
        {#each shownSingles as issue (issue.number)}
          <li>
            <button class="single" type="button" onclick={() => onselect(singleKey(issue.number))}>
              <span class="num">#{issue.number}</span>
              <span class="card-title">{issue.title}</span>
            </button>
          </li>
        {/each}
      </ul>
      {#if singles.length > SINGLES_SHOWN}
        <p class="note">{m.repooverview_more({ count: singles.length - SINGLES_SHOWN })}</p>
      {/if}
    </section>
  {/if}
</article>

<style>
  .overview {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
    padding: 14px 18px 24px;
    font-family: var(--font-mono);
  }

  .title {
    margin: 0;
    color: var(--color-ink-bright);
    font-size: var(--fs-2xl);
    font-weight: 600;
    line-height: 1.25;
    overflow-wrap: anywhere;
  }

  .note {
    margin: 0;
    color: var(--color-faint);
    font-size: var(--fs-micro);
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .group-head {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    font-weight: normal;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .singles {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* Panel-recipe cards; the whole card is the button that selects the epic. */
  .card,
  .single {
    display: flex;
    width: 100%;
    min-width: 0;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .card {
    flex-direction: column;
    gap: 4px;
    padding: 6px 8px;
  }
  .single {
    align-items: baseline;
    gap: 6px;
    padding: 4px 8px;
  }
  .card:hover,
  .single:hover {
    border-color: var(--color-line-bright);
  }
  .card:focus-visible,
  .single:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  .line {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 6px;
  }

  .num {
    flex: none;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .faint {
    color: var(--color-faint);
    font-size: var(--fs-micro);
  }
  .card-title {
    min-width: 0;
    overflow: hidden;
    color: var(--color-ink);
    font-size: var(--fs-meta);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Progress: merged share, slate like other merged markers. */
  .bar {
    height: 3px;
    border-radius: 2px;
    background: var(--color-line);
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
    background: var(--status-done);
  }

  /* Canonical .gbtn recipe from /design-system (scoped copy, as in EpicRunControl). */
  .gbtn {
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
</style>
