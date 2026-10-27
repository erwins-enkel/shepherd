<script lang="ts">
  import type {
    DrainRunSummary,
    DrainStatus,
    Epic,
    EpicAutoBlockers,
    EpicAutoFixOption,
    EpicAutoFixOptionId,
    EpicAutoFixState,
    EpicRunStatus,
    EpicSummary,
    GitState,
    Session,
  } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import {
    updateEpic,
    approveEpicNext,
    queueEpic,
    unqueueEpic,
    getDrain,
    overrideEpicBaseHold,
    reworkEpicBase,
    getEpicAutoFix,
    applyEpicAutoFix,
    ApiError,
  } from "#lib/api.js";
  import { basename } from "#lib/basename.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import { firstSafeHttpUrl } from "#lib/url.js";
  import { awaitingMerge, incrementalStallRisk, repoMergeGate } from "#lib/epic-merge-gate.js";
  import { epicLandingExplanation, epicRunStateExplanation } from "#lib/tooltips/explanations.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import {
    epicBaseActions,
    epicRole,
    epicRunState,
    epicRunStateLabel,
    epicRunSteps,
    epicRunWhy,
    queuedBehind,
    queuePosition,
    usageOverride,
  } from "../epic-panel";
  import { confirmText, haltedSettings, issueList, startable } from "../epic-auto-fix";
  import type { EpicOthersFlag } from "../issues-panel";
  import EpicAutoFixChooser from "./EpicAutoFixChooser.svelte";
  import EpicRunSteps from "./EpicRunSteps.svelte";
  import EpicRunSettings from "./EpicRunSettings.svelte";
  import EpicSupersedeDialog from "./EpicSupersedeDialog.svelte";
  import IssueDetailMenu from "./IssueDetailMenu.svelte";
  import RunPanel from "./RunPanel.svelte";

  // The epic detail's run area "Abarbeitung" (#2620): live state, every epic action, the
  // Now → Next → After steps and the CLI/model/effort footer. Replaces EpicPanel's hold line and
  // control bar. The host (IssueDetail) makes it sticky under the title.
  let {
    repoPath,
    parent,
    epic,
    drain = null,
    othersFlag = null,
    titleFor,
    epicSummaryFor = undefined,
    onselectepic = undefined,
    onopensession = undefined,
    onopenautomation = undefined,
    sessionInfo = undefined,
  }: {
    repoPath: string;
    parent: number;
    epic: Epic;
    /** The REPO's live drain status (its runSummary drives roles + steps). */
    drain?: DrainStatus | null;
    /** "Someone else is already working / owns this epic" (#1616) — a soft notice near Start. */
    othersFlag?: EpicOthersFlag | null;
    titleFor: (issue: number) => string | null;
    /** The repo's epic list entry for an epic — the leading epic's title and progress. */
    epicSummaryFor?: (parent: number) => EpicSummary | undefined;
    /** Opens another epic's detail — the leading one this epic waits for. */
    onselectepic?: (parent: number) => void;
    onopensession?: (sessionId: string) => void;
    onopenautomation?: () => void;
    /** A child session and its PR state, by id — names the PR a merge wait is on (#3423). */
    sessionInfo?: (id: string) => { session: Session; git?: GitState } | null;
  } = $props();

  const running = $derived(epic.run.status === "running");
  const role = $derived(epicRole(drain?.runSummary, parent));
  const runState = $derived(epicRunState(epic, parent, drain));
  const steps = $derived(epicRunSteps(epic, parent, drain));
  const canEnd = $derived(epic.run.status === "running" || epic.run.status === "paused");
  const canApprove = $derived(epic.run.mode === "attended" && running);
  // #2624: this epic's place in the repo's epic queue (null = not queued).
  const position = $derived(queuePosition(drain?.runSummary, parent));
  // Lifting the repo's usage ceiling for this run: offered while it halts there, else revocable.
  const ceiling = $derived(usageOverride(epic, parent, drain));
  // #3101: the run holds for its integration branch's base — resolve a conflict or continue anyway.
  const baseActions = $derived(epicBaseActions(epic, parent, drain));

  const inFlightText = $derived.by(() => {
    if (runState.inFlight.length) return runState.inFlight.map((n) => `#${n}`).join(", ");
    return steps?.now.map((h) => h.desig).join(", ") || "…";
  });

  const stateLabel = $derived(epicRunStateLabel(runState.kind, inFlightText, runState.position));

  // #3454: the repo's sandbox, the epic's CLI or this host holds the run. The auto-fix model
  // (#3453) names every cause and the ways out; a fix applies in one step and stays undoable here
  // until Undo or the next epic.
  const sandboxHalt = $derived(runState.kind === "halted_sandbox");
  const repoName = $derived(basename(repoPath));
  let blockers = $state<EpicAutoBlockers | null>(null);
  let fixBusy = $state(false);
  let fix = $state<{
    repoPath: string;
    parent: number;
    changes: EpicAutoFixOption["changes"];
    previous: EpicAutoFixState;
    starting: number[];
  } | null>(null);
  // The host may hand this instance another epic: a fix only belongs to the one it changed.
  const activeFix = $derived(fix?.repoPath === repoPath && fix.parent === parent ? fix : null);
  // Bumped by every load and adopt, so an answer that arrives late never overwrites a newer one.
  let blockersSeq = 0;
  function adoptBlockers(b: EpicAutoBlockers | null) {
    blockersSeq++;
    blockers = b;
  }
  // Re-asked whenever the hold or a setting the model reads changes.
  const haltKey = $derived(
    sandboxHalt
      ? [
          repoPath,
          parent,
          drain?.reason,
          drain?.detail,
          epic.run.agentProvider ?? "",
          repoConfig.sandboxProfileFor(repoPath),
        ].join("|")
      : null,
  );
  $effect(() => {
    if (haltKey == null) {
      adoptBlockers(null);
      return;
    }
    const seq = ++blockersSeq;
    // A failed load drops any earlier answer, so the hold note shows in place of the card.
    getEpicAutoFix(repoPath, parent)
      .then((b) => {
        if (seq === blockersSeq) blockers = b;
      })
      .catch(() => {
        if (seq === blockersSeq) blockers = null;
      });
  });
  const toStart = $derived(sandboxHalt ? startable(epic, drain?.runSummary) : null);
  const haltHead = $derived.by(() => {
    const ready = toStart?.ready ?? [];
    if (ready.length === 0) return m.epic_autofix_head_none();
    if (ready.length === 1) return m.epic_autofix_head_one({ issue: issueList(ready) });
    return m.epic_autofix_head_many({ issues: issueList(ready) });
  });
  const applyLabel = $derived(
    toStart?.starting.length
      ? m.epic_autofix_apply_start({ issues: issueList(toStart.starting) })
      : m.epic_autofix_apply(),
  );
  // The footer's CLI and Sandbox fields say "halts" while they are a cause.
  const halts = $derived(
    sandboxHalt ? haltedSettings(blockers, drain?.reason ?? null) : { cli: false, sandbox: false },
  );
  // What a fix started that holds no slot yet — the Now step lists it as starting.
  const startingNow = $derived.by(() => {
    if (!activeFix || runState.tone === "halt") return [];
    const held = new Set(drain?.runSummary?.slots.holders.map((h) => h.issueNumber));
    return activeFix.starting.filter(
      (n) => !held.has(n) && epic.children.some((c) => c.number === n && c.state === "ready"),
    );
  });

  function autoFixFailed(msg: string) {
    toasts.info(msg, { alert: true, key: "epic-autofix-fail" });
  }

  async function applyFix(option: EpicAutoFixOptionId) {
    const chosen = blockers?.options.find((o) => o.id === option);
    if (!chosen || fixBusy) return;
    const starting = toStart?.starting ?? [];
    fixBusy = true;
    try {
      const result = await applyEpicAutoFix(repoPath, parent, { option });
      adoptBlockers(result.blockers);
      fix = { repoPath, parent, changes: chosen.changes, previous: result.previous, starting };
      void repoConfig.reload(repoPath);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // The model moved on (a setting changed meanwhile): show its current ways.
        autoFixFailed(m.epic_autofix_unavailable());
        getEpicAutoFix(repoPath, parent)
          .then(adoptBlockers)
          .catch(() => {});
      } else autoFixFailed(m.epic_autofix_failed());
    } finally {
      fixBusy = false;
    }
  }

  async function undoFix() {
    if (!activeFix || fixBusy) return;
    fixBusy = true;
    try {
      const result = await applyEpicAutoFix(repoPath, parent, { restore: activeFix.previous });
      adoptBlockers(result.blockers);
      fix = null;
      void repoConfig.reload(repoPath);
    } catch {
      autoFixFailed(m.epic_autofix_undo_failed());
    } finally {
      fixBusy = false;
    }
  }

  // The repo's leading epic when it is another one — what a winding, superseded or ended epic
  // waits for.
  const otherLeader = $derived.by(() => {
    const leader = drain?.runSummary?.leadingEpic ?? null;
    return leader === parent ? null : leader;
  });
  // #2972: another epic leads and this one is not queued yet — offer queueing beside Start.
  const canQueue = $derived(!running && otherLeader != null && position == null);
  const stopped = $derived(
    runState.kind === "winding" || runState.kind === "superseded" || runState.kind === "ended",
  );
  // Why it does not run: what stopped it, when and through what, and who leads now.
  const why = $derived(stopped ? epicRunWhy(epic.runEnd, otherLeader, Date.now()) : []);

  const leaderLink = $derived.by(() => {
    if (!stopped || otherLeader == null) return null;
    const summary = epicSummaryFor?.(otherLeader);
    const title = summary?.parentTitle ?? titleFor(otherLeader);
    const progress = summary
      ? m.epicflow_merged({ merged: summary.merged, total: summary.total })
      : null;
    return (
      [`#${otherLeader}`, title].filter(Boolean).join(" ") + (progress ? ` · ${progress}` : "")
    );
  });

  // A winding-down epic says what still finishes and what stays behind; a superseded or ended one
  // what waits. A queued one names the epic it waits for.
  const note = $derived.by(() => {
    if (runState.kind === "queued") {
      const after = drain?.runSummary ? queuedBehind(drain.runSummary, parent) : null;
      return after == null ? null : m.epic_run_queued_note({ after });
    }
    if (runState.kind === "winding") {
      const parts = [m.epic_run_winding_note({ inflight: inFlightText })];
      if (steps?.kind === "winding" && steps.leftBehind > 0) {
        parts.push(m.epic_run_left_behind({ count: steps.leftBehind }));
      }
      return parts.join(" ");
    }
    if (runState.kind !== "superseded" && runState.kind !== "ended") return runState.note;
    const waiting = epic.children.filter((c) => c.state === "ready" || c.state === "blocked");
    const parts = [];
    if (waiting.length) parts.push(m.epic_run_idle_waiting({ count: waiting.length }));
    if (otherLeader != null) parts.push(m.epic_run_idle_waiting_hint({ leader: otherLeader }));
    return parts.join(" ") || null;
  });

  const othersNotice = $derived.by(() => {
    if (!othersFlag) return "";
    const who = othersFlag.who.join(", ");
    switch (othersFlag.tier) {
      case "inflight":
        return m.issuerow_epic_others_notice({ who });
      case "assigned":
        return m.issuerow_epic_assigned_notice({ who });
      default:
        return m.issuerow_epic_owner_notice({ who });
    }
  });

  let menuBtn = $state<HTMLButtonElement>();
  let menuOpen = $state(false);

  function updateFailed() {
    toasts.info(m.epic_update_failed(), { alert: true, key: "epic-update-fail" });
  }

  function setStatus(status: EpicRunStatus) {
    updateEpic(repoPath, parent, { status }).catch(updateFailed);
  }

  function setIgnoreCeiling(ignoreUsageCeiling: boolean) {
    updateEpic(repoPath, parent, { ignoreUsageCeiling }).catch(updateFailed);
  }

  function baseHoldFailed() {
    toasts.info(m.epic_base_action_failed(), { alert: true, key: "epic-base-fail" });
  }

  function baseReworkFailed(err: unknown) {
    const reason = err instanceof ApiError ? err.code : undefined;
    const msg =
      reason === "busy"
        ? m.epic_base_resolve_busy()
        : reason === "not-conflicting"
          ? m.epic_base_resolve_not_conflicting()
          : m.epic_base_resolve_failed();
    toasts.info(msg, { alert: true, key: "epic-base-fail" });
  }

  // Starting (or re-leading) while another epic leads supersedes it (the server keeps one epic
  // per repo) — ask first (#2623). The only UI path that sends `status: "running"`. The run
  // picture is captured on click, so the dialog neither vanishes nor reopens with the next tick.
  let confirming = $state<{ leader: number; summary: DrainRunSummary } | null>(null);
  // Asking the server who leads, because no run picture is loaded yet (#2972).
  let checking = $state(false);

  // Never supersede blind: without a loaded runSummary, fetch the repo's drain status first. A
  // repo missing from GET /api/drain has nothing leading. "error" = could not tell.
  async function freshSummary(): Promise<DrainRunSummary | null | "error"> {
    checking = true;
    try {
      const all = await getDrain();
      return all.find((d) => d.repoPath === repoPath)?.runSummary ?? null;
    } catch {
      return "error";
    } finally {
      checking = false;
    }
  }

  async function start() {
    if (checking) return;
    const summary = drain?.runSummary ?? (await freshSummary());
    if (summary === "error") {
      updateFailed();
      return;
    }
    const leader = summary?.leadingEpic ?? null;
    if (summary && leader != null && leader !== parent) confirming = { leader, summary };
    else setStatus("running");
  }

  // `requeue`: the superseded leader goes to the head of the epic queue instead of being dropped.
  function supersede(requeue: boolean) {
    confirming = null;
    updateEpic(repoPath, parent, { status: "running" }, { requeueLeader: requeue }).catch(
      updateFailed,
    );
  }

  // Queue behind the leader (#2624) — starts on its own once the epic ahead is complete.
  function queue() {
    queueEpic(repoPath, parent).catch(() =>
      toasts.info(m.epic_queue_failed(), { alert: true, key: "epic-queue-fail" }),
    );
  }

  function unqueue() {
    unqueueEpic(repoPath, parent).catch(() =>
      toasts.info(m.epic_unqueue_failed(), { alert: true, key: "epic-unqueue-fail" }),
    );
  }

  function toggleMode() {
    updateEpic(repoPath, parent, {
      mode: epic.run.mode === "auto" ? "attended" : "auto",
    }).catch(updateFailed);
  }

  // #3191: integration branch vs incremental. Fixed once the epic has run — the server answers a
  // late change with 409, which gets its own toast.
  const landing = $derived(epic.run.landing ?? "integration");
  const landingLocked = $derived(epic.landingLocked === true);
  // #3423: an incremental chain that nobody merges stalls silently — warn, and name the PR it waits on.
  $effect(() => {
    void repoConfig.ensure(repoPath);
  });
  const gate = $derived(repoMergeGate(repoConfig, repoPath));
  const stallRisk = $derived(
    !!gate &&
      incrementalStallRisk({
        landing,
        // Only edges still to advance: a landed dependent no longer waits on anyone.
        hasEdges: epic.children.some((c) => c.state !== "merged" && c.blockedBy.length > 0),
        mergeOff: gate.mergeOff,
        stacks: gate.stacks,
      }),
  );
  const mergeWaits = $derived(
    gate ? awaitingMerge(epic, gate.mergeOff, (id) => sessionInfo?.(id)?.git) : [],
  );
  const landingText = $derived(
    landing === "incremental" ? m.epic_landing_incremental() : m.epic_landing_integration(),
  );

  function toggleLanding() {
    if (landingLocked) return;
    updateEpic(repoPath, parent, {
      landing: landing === "incremental" ? "integration" : "incremental",
    }).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 409) {
        toasts.info(m.epic_landing_locked_failed(), { alert: true, key: "epic-update-fail" });
      } else updateFailed();
    });
  }

  function approveNext() {
    approveEpicNext(repoPath, parent).catch(() =>
      toasts.info(m.epic_approve_failed(), { alert: true, key: "epic-approve-fail" }),
    );
  }

  function endEpic() {
    updateEpic(repoPath, parent, { status: "idle" }).catch(() =>
      toasts.info(m.epic_stop_failed(), { alert: true, key: "epic-stop-fail" }),
    );
  }

  function pick(action: () => void) {
    menuOpen = false;
    action();
  }

  // Stopping the leader starts the queue's head (#2973) — the Stop item says which.
  const promotes = $derived(
    drain?.runSummary?.leadingEpic === parent ? drain.runSummary.queued?.[0] : undefined,
  );
  const menuItems = $derived([
    ...(canEnd
      ? [
          {
            label: m.epic_stop(),
            title: promotes == null ? undefined : m.epic_stop_promotes_title({ epic: promotes }),
            onselect: () => pick(endEpic),
          },
        ]
      : []),
    ...(canApprove ? [{ label: m.epic_approve_next(), onselect: () => pick(approveNext) }] : []),
  ]);
</script>

<RunPanel
  label={m.epic_run_label()}
  stateText={stateLabel}
  tone={runState.tone}
  kind={runState.kind}
  stateTip={epicRunStateExplanation()}
  data-epic-run
>
  {#snippet actions()}
    <div class="act-group" data-group="settings">
      <button
        class="gbtn"
        type="button"
        title={epic.run.mode === "auto" ? m.epic_mode_auto_title() : m.epic_mode_attended_title()}
        aria-label={epic.run.mode === "auto"
          ? m.epic_mode_auto_aria()
          : m.epic_mode_attended_aria()}
        onclick={toggleMode}
      >
        {epic.run.mode === "auto" ? m.epic_mode_auto() : m.epic_mode_attended()}
      </button>
      <!-- aria-disabled, not disabled: a locked toggle must stay hoverable/focusable so its
         explanation (why it is locked) is still reachable. -->
      <button
        class="gbtn"
        type="button"
        data-epic-landing={landing}
        aria-label={m.epic_landing_aria({ landing: landingText })}
        aria-disabled={landingLocked}
        use:statusTip={{
          text: epicLandingExplanation(landingLocked),
          stopClickPropagation: false,
        }}
        onclick={toggleLanding}
      >
        {landingText}
      </button>
    </div>
    <div class="act-group" data-group="commands">
      {#if position != null && !running}
        <button class="gbtn" type="button" title={m.epic_unqueue_title()} onclick={unqueue}
          >{m.epic_unqueue()}</button
        >
      {/if}
      {#if canQueue}
        <button class="gbtn" type="button" title={m.epic_queue_title()} onclick={queue}
          >{m.epic_queue()}</button
        >
      {/if}
      {#if running}
        <button
          class="gbtn"
          type="button"
          title={m.epic_pause_title()}
          onclick={() => setStatus("paused")}>{m.epic_pause()}</button
        >
      {:else if role === "winding" && otherLeader == null}
        <button
          class="gbtn"
          type="button"
          title={m.epic_run_restart_title()}
          disabled={checking}
          aria-busy={checking}
          onclick={start}>{m.epic_run_restart()}</button
        >
      {:else if role === "winding"}
        <button
          class="gbtn"
          type="button"
          title={m.epic_run_rejoin_title()}
          disabled={checking}
          aria-busy={checking}
          onclick={start}>{m.epic_run_rejoin()}</button
        >
      {:else}
        <button
          class="gbtn"
          type="button"
          title={otherLeader != null
            ? m.epic_start_supersede_title({ leader: otherLeader })
            : m.epic_start_title()}
          disabled={checking}
          aria-busy={checking}
          onclick={start}>{m.epic_start()}</button
        >
      {/if}
      {#if menuItems.length}
        <button
          bind:this={menuBtn}
          class="gbtn more"
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={m.epic_run_more()}
          title={m.epic_run_more()}
          onclick={() => (menuOpen = !menuOpen)}>⋯</button
        >
      {/if}
    </div>
  {/snippet}

  {#if why.length}
    <p class="why">{why.join(" ")}</p>
  {/if}

  {#if leaderLink && otherLeader != null}
    {#if onselectepic}
      <button
        class="leader-link"
        type="button"
        title={m.epic_run_leader_open({ leader: otherLeader })}
        onclick={() => onselectepic(otherLeader)}
        ><span aria-hidden="true">→</span> {leaderLink}</button
      >
    {:else}
      <p class="leader-link"><span aria-hidden="true">→</span> {leaderLink}</p>
    {/if}
  {/if}

  {#if sandboxHalt && blockers?.causes.length}
    <div class="halt-card" data-epic-halt-card>
      <p class="halt-head">{haltHead}</p>
      <EpicAutoFixChooser {blockers} {repoName} {applyLabel} busy={fixBusy} onapply={applyFix}>
        {#snippet extra()}
          {#if onopenautomation}
            <button class="link" type="button" onclick={onopenautomation}
              >{m.epic_autofix_all_settings()}</button
            >
          {/if}
        {/snippet}
      </EpicAutoFixChooser>
    </div>
  {:else if note && !(sandboxHalt && blockers)}
    <!-- A sandbox halt shows its note only until the model answers (or when it can't): once
         the model reports no cause, a fix just cleared it and the drain is catching up. -->
    <p class="note" class:alert={runState.tone === "halt"}>{note}</p>
  {/if}

  {#if activeFix}
    <p class="fixed" role="status" data-epic-autofix-done>
      <span class="fixed-mark" aria-hidden="true">✓</span>
      <span>{confirmText(activeFix.changes, repoName)}</span>
      <button class="link" type="button" disabled={fixBusy} onclick={undoFix}
        >{m.epic_autofix_undo()}</button
      >
    </p>
  {/if}

  {#each mergeWaits as w (w.child)}
    {@const href = firstSafeHttpUrl(w.url)}
    {@const text = m.epic_merge_wait({
      pr: w.pr,
      issues: w.blocks.map((n) => `#${n}`).join(", "),
    })}
    <p class="note alert" data-epic-merge-wait>
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
      {#if href}<a {href} target="_blank" rel="noopener noreferrer">{text}</a>{:else}{text}{/if}
    </p>
  {/each}

  {#if stallRisk}
    <p class="note alert" data-epic-stall-warning>{m.epic_incremental_stall_warning()}</p>
  {/if}

  {#if ceiling === "offer"}
    <div class="ceiling">
      <button class="gbtn" type="button" onclick={() => setIgnoreCeiling(true)}
        >{m.epic_usage_ignore()}</button
      >
    </div>
  {:else if ceiling === "active"}
    <div class="ceiling">
      <p class="note alert">{m.epic_usage_ignored_note()}</p>
      <button class="gbtn" type="button" onclick={() => setIgnoreCeiling(false)}
        >{m.epic_usage_respect()}</button
      >
    </div>
  {/if}

  {#if baseActions}
    <div class="ceiling">
      {#if baseActions.resolve}
        <button
          class="gbtn"
          type="button"
          onclick={() => reworkEpicBase(repoPath, parent).catch(baseReworkFailed)}
          >{m.epic_base_resolve()}</button
        >
      {/if}
      <button
        class="gbtn"
        type="button"
        onclick={() =>
          overrideEpicBaseHold(repoPath, parent, baseActions.override).catch(baseHoldFailed)}
        >{m.epic_base_continue()}</button
      >
    </div>
  {/if}

  {#if othersFlag}
    <p class="others-notice">
      <span class="others-glyph" aria-hidden="true">⚠</span>{othersNotice}
    </p>
  {/if}

  {#if steps}
    <EpicRunSteps
      {repoPath}
      {steps}
      {titleFor}
      onapprove={canApprove ? approveNext : undefined}
      {onopensession}
      starting={startingNow}
    />
  {/if}

  <div class="run-foot">
    <EpicRunSettings {repoPath} {parent} {epic} {halts} />
  </div>
</RunPanel>

{#if menuOpen && menuBtn && menuItems.length}
  <IssueDetailMenu
    anchor={menuBtn}
    label={m.epic_run_more()}
    items={menuItems}
    onclose={() => (menuOpen = false)}
  />
{/if}

{#if confirming}
  <EpicSupersedeDialog
    {repoPath}
    {parent}
    leader={confirming.leader}
    summary={confirming.summary}
    onconfirm={supersede}
    onclose={() => (confirming = null)}
    {onopenautomation}
  />
{/if}

<style>
  .note {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-micro);
  }
  .note.alert {
    color: var(--color-amber);
  }
  .note a {
    color: inherit;
    text-decoration: underline;
  }
  .ceiling {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  /* Why the epic does not run — the answer the operator came for, so it reads as body text. */
  .why {
    margin: 0;
    color: var(--color-ink);
    font-size: var(--fs-micro);
  }
  .leader-link {
    align-self: flex-start;
    margin: 0;
    padding: 0;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    text-align: left;
  }
  button.leader-link {
    text-decoration: underline;
    cursor: pointer;
  }
  button.leader-link:hover,
  button.leader-link:focus-visible {
    outline: none;
    color: var(--color-amber);
  }

  /* Soft, non-blocking "someone else is already working / owns this epic" notice (#1616),
     next to Start. Amber running token, dimmed toward muted. */
  .others-notice {
    margin: 0;
    display: flex;
    align-items: baseline;
    gap: 4px;
    font-size: var(--fs-micro);
    color: color-mix(in oklab, var(--status-running) 80%, var(--color-muted));
  }
  .others-glyph {
    color: var(--status-running);
  }

  /* #3454: the sandbox/CLI/host halt — red-washed so it reads as the reason nothing starts. */
  .halt-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px 12px;
    background: var(--wash-attention);
    border: 1px solid color-mix(in srgb, var(--color-red) 45%, var(--color-line));
    border-radius: 2px;
  }
  .halt-head {
    margin: 0;
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 600;
  }

  /* The fix is applied: what it set, and the way back. */
  .fixed {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 8px;
    margin: 0;
    color: var(--color-ink);
    font-size: var(--fs-meta);
  }
  .fixed-mark {
    color: var(--status-done);
  }

  /* Text-link recipe (as EpicRunSteps' .link): a real button, styled as inline text. */
  .link {
    padding: 0;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    text-decoration: underline;
    cursor: pointer;
  }
  .link:hover:not(:disabled),
  .link:focus-visible {
    color: var(--color-amber);
    outline: none;
  }
  .link:disabled {
    cursor: progress;
  }

  .run-foot {
    padding-top: 6px;
    border-top: 1px solid var(--color-line);
  }

  /* Settings (mode, landing) and commands (queue, pause/start, ⋯) wrap as units. On a narrow
     panel each takes a full row whose buttons share the width, the primary command first. */
  .act-group {
    display: flex;
    gap: 6px;
  }
  @container run-panel (max-width: 560px) {
    .act-group {
      flex-basis: 100%;
    }
    .act-group[data-group="commands"] {
      order: -1;
    }
    .act-group > .gbtn {
      flex: 1 1 auto;
    }
    .act-group > .gbtn.more {
      flex: none;
      min-width: 44px;
    }
  }

  /* Canonical .gbtn recipe from /design-system (scoped copy, as in EpicPanel). */
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
  .gbtn:hover:not(:disabled, [aria-disabled="true"]),
  .gbtn[aria-expanded="true"] {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:disabled {
    cursor: progress;
    opacity: 0.6;
  }
  .gbtn[aria-disabled="true"] {
    cursor: not-allowed;
    opacity: 0.6;
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
    .link {
      min-height: 44px;
    }
  }
</style>
