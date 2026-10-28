<script lang="ts">
  import type { DrainStatus, Epic, EpicAutoFixOptionId, EpicSummary } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { labelChipStyle } from "#lib/label-color.js";
  import { basename } from "#lib/basename.js";
  import { repoOverviewRunExplanation } from "#lib/tooltips/explanations.js";
  import { RepoPrecheck } from "#lib/repo-precheck.svelte.js";
  import { repoBootstrap } from "#lib/repo-bootstrap.svelte.js";
  import {
    epicRole,
    epicRunState,
    epicRunStateLabel,
    epicRunSteps,
    overviewRunState,
    queuePosition,
    sandboxHaltedEpic,
  } from "../epic-panel";
  import { epicKey, STALE_DAYS, type RunningIssue, type StaleSummary } from "../issues-panel";
  import { epicHaltView, repoHaltView } from "../repo-halt";
  import { drainHold } from "../epic-hold";
  import RunPanel from "./RunPanel.svelte";
  import RepoHaltBanner from "./RepoHaltBanner.svelte";
  import EpicCardHalt from "./EpicCardHalt.svelte";
  import EpicHoldLine from "./EpicHoldLine.svelte";
  import "./halt-controls.css";
  import EpicRunSteps from "./EpicRunSteps.svelte";
  import EpicRoleBadge from "./EpicRoleBadge.svelte";
  import EpicQueueList from "./EpicQueueList.svelte";
  import InfoTip from "../InfoTip.svelte";

  // The reading detail with nothing selected (#2622): what is happening in this repo. The run
  // area "Abarbeitung im Repo" (which epic leads, its Now → Next → After steps, epics winding
  // down, landing repairs that hold no slot, the agent-slot cap and the reorderable epic queue,
  // #2973), then every epic with its role and progress. Below that, what the
  // list beside it can't say (#2638), in two columns (#2950): left what runs right now (even
  // when the list's filters hide it) and what has lain untouched, right the open issues per
  // label as list filters; then the next step. No second issue list — the list is right there.
  // A halt in the repo's sandbox or on this host is said once, at the top of the run area; each
  // epic card shows its own cause or its pre-check (#3456). The drain's other holds likewise: the
  // repo's (project bootstrap) once at the top, the run's or the epic's at its card (#3457).

  let {
    repoPath,
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

  const leaderRun = $derived(
    record && leading != null ? epicRunState(record, leading, drain) : null,
  );
  // Tone and dot shape (#2639); landing repairs hold no slot (#2973) but still run.
  const indicator = $derived(overviewRunState(summary, leaderRun));
  const stateText = $derived.by((): string => {
    if (leading == null) return m.repooverview_none_leading();
    if (!leaderRun) return m.repooverview_leading_only({ epic: leading });
    const inflight = leaderRun.inFlight.map((n) => `#${n}`).join(", ") || "…";
    return m.repooverview_leading({
      epic: leading,
      state: epicRunStateLabel(leaderRun.kind, inflight),
    });
  });
  const slots = $derived(
    summary
      ? { used: summary.slots.used, max: summary.slots.max }
      : drain
        ? { used: drain.inFlight, max: drain.max }
        : null,
  );

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

  // #3456: every epic still to finish gets its pre-check — the leader, queued and not-started
  // ones; an epic winding down starts nothing new.
  const precheck = new RepoPrecheck();
  const candidates = $derived(
    cards
      .filter((c) => c.role !== "winding" && c.epic.merged < c.epic.total)
      .map((c) => c.epic.parentIssueNumber),
  );
  $effect(() => precheck.watch(repoPath, candidates, drain));
  $effect(() => void repoBootstrap.load(repoPath));
  const repoName = $derived(basename(repoPath));
  const halted = $derived(sandboxHaltedEpic(drain));
  const repoHalt = $derived(repoHaltView(precheck.models, candidates, halted));
  const cardHalts = $derived(
    Object.fromEntries(
      candidates.flatMap((p) => {
        const model = precheck.models[p];
        const view = model
          ? epicHaltView(model, {
              halted: p === halted,
              bootstrap: repoBootstrap.viewFor(repoPath),
            })
          : null;
        return view ? [[p, view]] : [];
      }),
    ),
  );
  // #3457: bootstrap, usage, base, agent or approval — with the action that already exists.
  const hold = $derived(drainHold(drain));
  const repoHold = $derived(hold?.scope === "repo" ? hold : null);
  // The run's or the epic's hold sits at the card of the epic the drain runs — none in label mode.
  const epicHold = $derived(
    hold && hold.scope !== "repo" && drain?.epicParent != null ? hold : null,
  );
  const showLegend = $derived(
    repoHalt != null || Object.keys(cardHalts).length > 0 || repoHold != null || epicHold != null,
  );
  // The banner's chooser offers the held epic's ways; a fix confirms where it was applied.
  const bannerTarget = $derived(repoHalt ? (precheck.models[repoHalt.target] ?? null) : null);
  const bannerFix = $derived(precheck.applied?.at === "repo" ? precheck.applied : null);

  function cardHalt(parent: number) {
    return cardHalts[parent] ?? null;
  }
  function cardHold(parent: number) {
    return drain?.epicParent === parent ? epicHold : null;
  }
  function cardFix(parent: number) {
    const fix = precheck.applied;
    return fix?.at === "epic" && fix.parent === parent ? fix : null;
  }
  function applyAutonomous(): Promise<boolean> {
    const via = repoHalt?.autonomous;
    return via == null
      ? Promise.resolve(false)
      : precheck.applyCause(via, "sandbox_interactive", "repo");
  }
  function applyBannerWay(option: EpicAutoFixOptionId): Promise<boolean> {
    return repoHalt ? precheck.applyOption(repoHalt.target, option) : Promise.resolve(false);
  }

  // Queue rows name the epic by its list entry, else by whatever the host knows.
  function epicTitle(parent: number): string | null {
    return epics.find((e) => e.parentIssueNumber === parent)?.parentTitle ?? titleFor(parent);
  }

  const maxLabelCount = $derived(Math.max(1, ...labels.map((l) => l.count)));

  function runningMeta(r: RunningIssue): string {
    return [
      r.desig ?? m.repooverview_running_label_only(),
      ...(r.hidden ? [m.repooverview_running_hidden()] : []),
    ].join(" · ");
  }
</script>

<article class="overview" aria-label={m.repooverview_title()}>
  <h2 class="title">{m.repooverview_title()}</h2>

  <RunPanel
    label={m.repooverview_run_label()}
    {stateText}
    tone={indicator.tone}
    kind={indicator.kind}
    dot={indicator.dot}
    data-repo-run
  >
    {#snippet actions()}
      {#if slots}
        <span class="slots-value" data-slots-value>{m.repooverview_slots_value(slots)}</span>
      {/if}
      {#if onopenautomation}
        <button class="gbtn" type="button" onclick={onopenautomation}
          >{m.repooverview_change()}</button
        >
      {/if}
      <InfoTip text={repoOverviewRunExplanation()} label={m.tooltip_repo_run_title()} />
    {/snippet}

    <RepoHaltBanner
      view={repoHalt}
      {repoName}
      target={bannerTarget}
      applied={bannerFix}
      busy={precheck.busy}
      onautonomous={applyAutonomous}
      onapply={applyBannerWay}
      onundo={() => void precheck.undo()}
    />
    <EpicHoldLine
      {repoPath}
      parent={drain?.epicParent ?? null}
      view={repoHold}
      {onopensession}
      {onopenautomation}
    />
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
    {#each summary?.landingRepairs ?? [] as r (r.sessionId)}
      <p class="note" data-landing-repair>
        {r.epicParent != null
          ? m.repooverview_landing_repair({ epic: r.epicParent })
          : m.repooverview_landing_repair_desig({ desig: r.desig })}
      </p>
    {/each}
    {#if summary?.queued?.length}
      <EpicQueueList
        {repoPath}
        queued={summary.queued}
        titleFor={epicTitle}
        onselect={(n) => onselect(epicKey(n))}
      />
    {/if}
  </RunPanel>

  {#if cards.length}
    <section class="group" aria-label={m.repooverview_epics()}>
      <h3 class="group-head">{m.repooverview_epics()}</h3>
      <ul class="rows">
        {#each cards as { epic, role, position } (epic.parentIssueNumber)}
          {@const parent = epic.parentIssueNumber}
          <li>
            <button
              class="orow"
              type="button"
              data-epic-row
              onclick={() => onselect(epicKey(epic.parentIssueNumber))}
            >
              <span class="orow-body">
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
              </span>
              <span class="arrow" aria-hidden="true">›</span>
            </button>
            <!-- Beside the card's button, not in it: the halt has buttons of its own. -->
            <EpicHoldLine
              {repoPath}
              {parent}
              view={cardHold(parent)}
              {onopensession}
              {onopenautomation}
            />
            <EpicCardHalt
              view={cardHalt(parent)}
              {repoName}
              applied={cardFix(parent)}
              busy={precheck.busy}
              onaction={(code) => precheck.applyCause(parent, code, "epic")}
              onundo={() => void precheck.undo()}
            />
          </li>
        {/each}
      </ul>
      {#if showLegend}
        <ul class="legend" aria-label={m.tooltip_autofix_scope_title()} data-halt-legend>
          <li>
            <span class="hc-chip">{m.epic_autofix_scope_repo()}</span>
            {m.repooverview_legend_repo()}
          </li>
          <li>
            <span class="hc-chip">{m.epic_autofix_scope_epic()}</span>
            {m.repooverview_legend_epic()}
          </li>
          <li>
            <span class="hc-chip">{m.epic_autofix_scope_host()}</span>
            {m.repooverview_legend_host()}
          </li>
          {#if epicHold?.scope === "run"}
            <li>
              <span class="hc-chip">{m.epic_autofix_scope_run()}</span>
              {m.repooverview_legend_run()}
            </li>
          {/if}
        </ul>
      {/if}
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
                    <span class="arrow" aria-hidden="true">›</span>
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
    <ul class="rows">
      <li class="orow next-row">
        <span class="orow-body">
          <span class="next-title">{m.repooverview_next_single_title()} <kbd>A</kbd></span>
          <span class="note">{m.repooverview_next_single_body()}</span>
        </span>
      </li>
      {#if ondraftepic}
        <li class="orow next-row">
          <span class="orow-body">
            <span class="next-title">{m.repooverview_next_epic_title()}</span>
            <span class="note">{m.repooverview_next_epic_body()}</span>
            <button class="gbtn primary" type="button" onclick={ondraftepic}
              >{m.repooverview_draft_epic()}</button
            >
          </span>
        </li>
      {/if}
    </ul>
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

  /* Borderless list rows (#2639), shared by the epics and the next steps: one column, a hover
     ground and a trailing ›. An epic row is the button that selects the epic. */
  .rows {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .orow {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-width: 0;
    padding: 6px 8px;
    background: transparent;
    border: 0;
    border-radius: 2px;
    color: inherit;
    font: inherit;
    text-align: left;
  }
  button.orow {
    cursor: pointer;
  }
  /* Only actionable rows answer hover — the next-step rows are information, not targets. */
  button.orow:hover {
    background: var(--color-panel);
  }
  .orow:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .orow-body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .next-row .orow-body {
    align-items: flex-start;
  }
  .arrow {
    flex: none;
    color: var(--color-faint);
    font-size: var(--fs-base);
  }
  button.orow:hover .arrow,
  .label-row:hover .arrow {
    color: var(--color-ink);
  }

  .slots-value {
    color: var(--color-ink);
    font-size: var(--fs-meta);
  }

  /* #3457: the drain's hold at its epic's card, indented as EpicCardHalt's lines. */
  .rows > li > :global([data-epic-hold]) {
    margin: 0 8px 6px;
  }

  /* #3456: what the scope chips mean, once under the epics. */
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 22px;
    margin: 4px 0 0;
    padding: 8px 8px 0;
    border-top: 1px solid var(--color-line);
    color: var(--color-muted);
    font-size: var(--fs-micro);
    list-style: none;
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
    grid-template-columns: minmax(0, 9rem) minmax(0, 1fr) 3ch auto;
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
