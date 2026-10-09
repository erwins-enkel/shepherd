<script lang="ts">
  import type { DrainStatus, Epic, EpicSummary } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { labelChipStyle } from "#lib/label-color.js";
  import {
    epicRole,
    epicRunState,
    epicRunStateLabel,
    epicRunSteps,
    queuePosition,
    type EpicRunTone,
  } from "../epic-panel";
  import { epicKey, STALE_DAYS, type RunningIssue, type StaleSummary } from "../issues-panel";
  import RunPanel from "./RunPanel.svelte";
  import EpicRunSteps from "./EpicRunSteps.svelte";
  import EpicRoleBadge from "./EpicRoleBadge.svelte";

  // The reading detail with nothing selected (#2622): what is happening in this repo. The run
  // area "Abarbeitung im Repo" (which epic leads, its Now → Next → After steps, epics winding
  // down, the agent-slot cap), then every epic with its role and progress. Below that, what the
  // list beside it can't say (#2638), in two columns (#2950): left what runs right now (even
  // when the list's filters hide it) and what has lain untouched, right the open issues per
  // label as list filters; then the next step. No second issue list — the list is right there.

  let {
    repoPath,
    repoName,
    epics,
    running,
    labels,
    labelColors,
    stale,
    oldestFirst,
    drain = null,
    leadingRecord = undefined,
    titleFor,
    onselect,
    onfilterlabel,
    ontoggleoldest,
    ondraftepic = undefined,
    onopensession = undefined,
    onopenautomation = undefined,
  }: {
    repoPath: string;
    repoName: string;
    /** The repo's epics, in list order. */
    epics: readonly EpicSummary[];
    /** Single issues being worked right now, whether or not the list shows them. */
    running: readonly RunningIssue[];
    /** Open issues per label, most first. */
    labels: readonly { label: string; count: number }[];
    /** Label name → forge hex, for the label rows' hue. */
    labelColors: Record<string, string>;
    stale: StaleSummary;
    /** The list currently sorts oldest first. */
    oldestFirst: boolean;
    drain?: DrainStatus | null;
    /** The leading epic's record; undefined while it loads (or when no epic leads). */
    leadingRecord?: Epic;
    titleFor: (issue: number) => string | null;
    /** Select a list entry by its row key. */
    onselect: (key: string) => void;
    /** Show only this label's issues in the list. */
    onfilterlabel: (label: string) => void;
    ontoggleoldest: () => void;
    /** Open the New Task composer set to draft an epic. Omitted → no button. */
    ondraftepic?: () => void;
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
      .map((e) => ({
        epic: e,
        role: epicRole(summary, e.parentIssueNumber),
        position: queuePosition(summary, e.parentIssueNumber),
      }))
      .sort((a, b) => rank(a.role) - rank(b.role) || (a.position ?? 0) - (b.position ?? 0)),
  );
  function rank(role: ReturnType<typeof epicRole>): number {
    return role === "leading" ? 0 : role === "winding" ? 1 : role === "queued" ? 2 : 3;
  }

  const maxLabelCount = $derived(Math.max(1, ...labels.map((l) => l.count)));

  function runningMeta(r: RunningIssue): string {
    return [
      r.desig ?? m.repooverview_running_label_only(),
      ...(r.hidden ? [m.repooverview_running_hidden()] : []),
    ].join(" · ");
  }
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
      <EpicRunSteps {repoPath} {steps} {titleFor} {onopensession} />
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
        {#each cards as { epic, role, position } (epic.parentIssueNumber)}
          <li>
            <button
              class="card"
              type="button"
              onclick={() => onselect(epicKey(epic.parentIssueNumber))}
            >
              <span class="line">
                <span class="num">#{epic.parentIssueNumber}</span>
                {#if role}<EpicRoleBadge {role} {position} />{/if}
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

  {#if running.length || labels.length || stale.total}
    <div class="facts">
      {#if running.length || stale.total}
        <div class="facts-col">
          {#if running.length}
            <section class="group" aria-label={m.repooverview_running({ count: running.length })}>
              <h3 class="group-head">{m.repooverview_running({ count: running.length })}</h3>
              <ul class="running">
                {#each running as r (r.issue.number)}
                  <li class="run-row">
                    <span class="run-dot" aria-hidden="true"></span>
                    <span class="run-text">
                      <span class="run-title"
                        ><span class="num">#{r.issue.number}</span> {r.issue.title}</span
                      >
                      <span class="faint">{runningMeta(r)}</span>
                    </span>
                    {#if r.sessionId && onopensession}
                      {@const id = r.sessionId}
                      <button class="gbtn" type="button" onclick={() => onopensession(id)}
                        >{m.epic_run_open_session()}</button
                      >
                    {/if}
                  </li>
                {/each}
              </ul>
            </section>
          {/if}
          {#if stale.total}
            <section class="group" aria-label={m.repooverview_stale()}>
              <h3 class="group-head">{m.repooverview_stale()}</h3>
              <p class="stale-count">
                {m.repooverview_stale_count({
                  stale: stale.stale,
                  total: stale.total,
                  days: STALE_DAYS,
                })}
              </p>
              <span class="bar" aria-hidden="true"
                ><span class="fill stale-fill" style:width="{(stale.stale / stale.total) * 100}%"
                ></span></span
              >
              {#if stale.oldest}
                <p class="note">
                  {m.repooverview_oldest({
                    number: stale.oldest.issue.number,
                    title: stale.oldest.issue.title,
                    days: stale.oldest.days,
                  })}
                </p>
              {/if}
              <button
                class="gbtn oldest"
                type="button"
                aria-pressed={oldestFirst}
                onclick={ontoggleoldest}>{m.issuespanel_oldest_first()}</button
              >
            </section>
          {/if}
        </div>
      {/if}
      {#if labels.length}
        <div class="facts-col">
          <section class="group" aria-label={m.repooverview_labels()}>
            <h3 class="group-head">{m.repooverview_labels()}</h3>
            <ul class="labels">
              {#each labels as { label, count } (label)}
                {@const hue = labelChipStyle(labelColors[label] ?? "")}
                <li>
                  <button
                    class="label-row"
                    class:hued={hue !== null}
                    style={hue}
                    type="button"
                    aria-label={m.repooverview_label_filter({ label, count })}
                    onclick={() => onfilterlabel(label)}
                  >
                    <span class="label-name"><span class="label-dot"></span>{label}</span>
                    <span class="bar" aria-hidden="true"
                      ><span class="fill label-fill" style:width="{(count / maxLabelCount) * 100}%"
                      ></span></span
                    >
                    <span class="label-count">{count}</span>
                  </button>
                </li>
              {/each}
            </ul>
            <p class="note">{m.repooverview_labels_hint()}</p>
          </section>
        </div>
      {/if}
    </div>
  {/if}

  <section class="group" aria-label={m.repooverview_next()}>
    <h3 class="group-head">{m.repooverview_next()}</h3>
    <div class="next">
      <div class="next-card">
        <span class="next-title">{m.repooverview_next_single_title()} <kbd>A</kbd></span>
        <span class="note">{m.repooverview_next_single_body()}</span>
      </div>
      {#if ondraftepic}
        <div class="next-card">
          <span class="next-title">{m.repooverview_next_epic_title()}</span>
          <span class="note">{m.repooverview_next_epic_body()}</span>
          <button class="gbtn primary" type="button" onclick={ondraftepic}
            >{m.repooverview_draft_epic()}</button
          >
        </div>
      {/if}
    </div>
  </section>
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
  /* Panel-recipe cards; the whole card is the button that selects the epic. */
  .card {
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
  .card:hover {
    border-color: var(--color-line-bright);
  }
  .card:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  /* Running now (#2638): one line per issue, its session one click away. */
  .running {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .run-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border-top: 1px solid var(--color-line);
  }
  .run-row:last-child {
    border-bottom: 1px solid var(--color-line);
  }
  .run-dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--status-running);
  }
  .run-text {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .run-title {
    color: var(--color-ink-bright);
    font-size: var(--fs-meta);
    overflow-wrap: anywhere;
  }

  /* Two columns while there is room (#2950): what runs and what lies on the left, the open
     issues per label on the right. One column when the reading view is narrow. */
  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    align-items: start;
    gap: 14px 28px;
  }
  .facts-col {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
  }
  .labels {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  /* A label row filters the list. Forge label hue as in the filter popover's chips — the
     sanctioned data-color exception; neutral when the forge sends no color. */
  .label-row {
    --label-ink: var(--color-ink);
    --label-dot: var(--color-muted);
    display: grid;
    grid-template-columns: minmax(0, 9rem) minmax(0, 1fr) 3ch;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 26px;
    padding: 0 6px;
    background: transparent;
    border: 0;
    border-radius: 2px;
    color: var(--label-ink);
    font: inherit;
    font-size: var(--fs-meta);
    text-align: left;
    cursor: pointer;
  }
  .label-row.hued {
    --label-ink: var(--lc-text-d);
    --label-dot: var(--lc-text-d);
  }
  :global([data-theme="light"]) .label-row.hued {
    --label-ink: var(--lc-text-l);
    --label-dot: var(--lc-text-l);
  }
  .label-row:hover {
    background: var(--color-panel);
  }
  .label-row:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .label-name {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .label-dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--label-dot);
  }
  .fill.label-fill {
    background: var(--label-dot);
  }
  .label-count {
    color: var(--color-ink);
    text-align: right;
  }

  .stale-count {
    margin: 0;
    color: var(--color-ink-bright);
    font-size: var(--fs-meta);
  }
  .fill.stale-fill {
    background: var(--color-muted);
  }
  .oldest {
    align-self: flex-start;
  }

  /* Next step: start one issue by hand, or bundle several into an epic. */
  .next {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 8px;
  }
  .next-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    padding: 10px 12px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
  }
  .next-title {
    color: var(--color-ink-bright);
    font-size: var(--fs-meta);
  }
  kbd {
    padding: 0 5px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
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
  .gbtn.primary,
  .gbtn[aria-pressed="true"] {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  @media (max-width: 768px), (max-height: 600px) {
    .gbtn,
    .label-row {
      min-height: 44px;
    }
    .gbtn {
      padding: 2px 14px;
    }
  }
</style>
