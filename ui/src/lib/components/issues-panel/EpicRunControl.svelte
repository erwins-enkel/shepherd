<script lang="ts">
  import type { DrainStatus, Epic, EpicRunStatus } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { updateEpic, approveEpicNext } from "$lib/api";
  import { toasts } from "$lib/toasts.svelte";
  import { epicRunStateExplanation } from "$lib/tooltips/explanations";
  import { epicRole, epicRunState, epicRunStateLabel, epicRunSteps } from "../epic-panel";
  import type { EpicOthersFlag } from "../issues-panel";
  import EpicRunSteps from "./EpicRunSteps.svelte";
  import EpicRunSettings from "./EpicRunSettings.svelte";
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
    onopensession = undefined,
    onopenautomation = undefined,
  }: {
    repoPath: string;
    parent: number;
    epic: Epic;
    /** The REPO's live drain status (its runSummary drives roles + steps). */
    drain?: DrainStatus | null;
    /** "Someone else is already working / owns this epic" (#1616) — a soft notice near Start. */
    othersFlag?: EpicOthersFlag | null;
    titleFor: (issue: number) => string | null;
    onopensession?: (sessionId: string) => void;
    onopenautomation?: () => void;
  } = $props();

  const running = $derived(epic.run.status === "running");
  const role = $derived(epicRole(drain?.runSummary, parent));
  const runState = $derived(epicRunState(epic, parent, drain));
  const steps = $derived(epicRunSteps(epic, parent, drain));
  const canEnd = $derived(epic.run.status === "running" || epic.run.status === "paused");
  const canApprove = $derived(epic.run.mode === "attended" && running);

  const inFlightText = $derived.by(() => {
    if (runState.inFlight.length) return runState.inFlight.map((n) => `#${n}`).join(", ");
    return steps?.now.map((h) => h.desig).join(", ") || "…";
  });

  const stateLabel = $derived(epicRunStateLabel(runState.kind, inFlightText));

  // A winding-down epic explains itself: who leads now, what still finishes, what stays behind.
  const note = $derived.by(() => {
    if (runState.kind !== "winding") return runState.note;
    const parts = [];
    if (steps?.kind === "winding" && steps.leader != null) {
      parts.push(m.epic_run_winding_leader({ leader: steps.leader }));
    }
    parts.push(m.epic_run_winding_note({ inflight: inFlightText }));
    if (steps?.kind === "winding" && steps.leftBehind > 0) {
      parts.push(m.epic_run_left_behind({ count: steps.leftBehind }));
    }
    return parts.join(" ");
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

  function toggleMode() {
    updateEpic(repoPath, parent, {
      mode: epic.run.mode === "auto" ? "attended" : "auto",
    }).catch(updateFailed);
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

  const menuItems = $derived([
    ...(canEnd ? [{ label: m.epic_stop(), onselect: () => pick(endEpic) }] : []),
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
    <button
      class="gbtn"
      type="button"
      title={epic.run.mode === "auto" ? m.epic_mode_auto_title() : m.epic_mode_attended_title()}
      aria-label={epic.run.mode === "auto" ? m.epic_mode_auto_aria() : m.epic_mode_attended_aria()}
      onclick={toggleMode}
    >
      {epic.run.mode === "auto" ? m.epic_mode_auto() : m.epic_mode_attended()}
    </button>
    {#if running}
      <button
        class="gbtn"
        type="button"
        title={m.epic_pause_title()}
        onclick={() => setStatus("paused")}>{m.epic_pause()}</button
      >
    {:else if role === "winding"}
      <button
        class="gbtn"
        type="button"
        title={m.epic_run_rejoin_title()}
        onclick={() => setStatus("running")}>{m.epic_run_rejoin()}</button
      >
    {:else}
      <button
        class="gbtn"
        type="button"
        title={m.epic_start_title()}
        onclick={() => setStatus("running")}>{m.epic_start()}</button
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
  {/snippet}

  {#if note}
    <p class="note" class:alert={runState.tone === "halt"}>{note}</p>
  {/if}

  {#if othersFlag}
    <p class="others-notice">
      <span class="others-glyph" aria-hidden="true">⚠</span>{othersNotice}
    </p>
  {/if}

  {#if steps}
    <EpicRunSteps
      {steps}
      {titleFor}
      onapprove={canApprove ? approveNext : undefined}
      {onopensession}
      {onopenautomation}
    />
  {/if}

  <div class="run-foot">
    <EpicRunSettings {repoPath} {parent} {epic} />
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

<style>
  .note {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-micro);
  }
  .note.alert {
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

  .run-foot {
    padding-top: 6px;
    border-top: 1px solid var(--color-line);
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
  .gbtn:hover:not(:disabled),
  .gbtn[aria-expanded="true"] {
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
