<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { repoBootstrap } from "#lib/repo-bootstrap.svelte.js";
  import { bootstrapSequencerExplanation } from "#lib/tooltips/explanations.js";
  import InfoTip from "./InfoTip.svelte";
  import { bootstrapMissingText } from "./queue-strip";
  import { READINESS_PENDING } from "./readiness-greenfield-view";
  import {
    checklistAction,
    checklistMustHaves,
    checklistStepKind,
    checklistSteps,
    type BootstrapStepKind,
    type ChecklistAction,
    type ChecklistStepId,
    type ChecklistStepState,
  } from "./bootstrap-checklist";

  // The Backlog's bootstrap checklist (#3112): where an active-bootstrap repo stands, drawn as one
  // track (P1+P2 → P3 → P4 → exit), with its one next step pinned under the current stop. The
  // server advances the phase; this only PROPOSES the next attended session — the operator's one
  // click starts it (#3421), nothing starts without it. "Adjust first" (`adjust`) opens the seeded
  // composer without starting.
  let {
    repoPath,
    onbootstrapstep = undefined,
    onopensession = undefined,
    onopenreadiness = undefined,
  }: {
    repoPath: string;
    onbootstrapstep?: (repoPath: string, kind: BootstrapStepKind, adjust: boolean) => void;
    onopensession?: (sessionId: string) => void;
    onopenreadiness?: () => void;
  } = $props();

  $effect(() => {
    void repoBootstrap.load(repoPath);
  });

  const view = $derived(repoBootstrap.viewFor(repoPath));
  const action = $derived(view ? checklistAction(view) : null);
  const stepKind = $derived(action ? checklistStepKind(action) : null);
  const steps = $derived(view ? checklistSteps(view.phase, !!view.ciHold) : []);
  // The stop the next-step card points at.
  const at = $derived(steps.findIndex((s) => s.state === "current" || s.state === "held"));
  const mustHaves = $derived(view ? checklistMustHaves(view) : []);
  const pending = $derived(mustHaves.includes(READINESS_PENDING));
  const exitOutcome = $derived(
    pending
      ? m.readiness_gf_pending()
      : mustHaves.length === 0
        ? m.bootstrap_checklist_out_exit_green()
        : m.bootstrap_checklist_out_exit_open({
            missing: bootstrapMissingText(mustHaves.join(",")),
          }),
  );

  const STEP_LABEL: Record<ChecklistStepId, () => string> = {
    scaffold: () => m.bootstrap_checklist_step_scaffold(),
    gaps: () => m.automation_bootstrap_phase_3(),
    backlog: () => m.automation_bootstrap_phase_4(),
    exit: () => m.bootstrap_checklist_step_exit(),
  };

  // What each stop delivers; the exit stop shows the must-haves still holding the drain.
  const STEP_OUT: Record<ChecklistStepId, () => string> = {
    scaffold: () => m.bootstrap_checklist_out_scaffold(),
    gaps: () => m.bootstrap_checklist_out_gaps(),
    backlog: () => m.bootstrap_checklist_out_backlog(),
    exit: () => exitOutcome,
  };

  function badgeText(state: ChecklistStepState): string {
    switch (state) {
      case "done":
        return m.bootstrap_checklist_badge_done();
      case "held":
        return m.bootstrap_checklist_badge_merged();
      case "todo":
        return m.bootstrap_checklist_badge_todo();
      case "current":
        return action?.kind === "open-session"
          ? m.bootstrap_checklist_badge_running()
          : m.bootstrap_checklist_badge_now();
    }
  }

  function eyebrowText(a: ChecklistAction): string {
    switch (a.kind) {
      case "ci-waiting":
        return m.bootstrap_checklist_eyebrow_ci_waiting();
      case "fix-ci":
        return m.bootstrap_checklist_eyebrow_ci_failed();
      case "open-session":
        return m.bootstrap_checklist_badge_running();
      case "open-readiness":
        return m.bootstrap_checklist_eyebrow_exit();
      case "start-bootstrap":
      case "start-epic":
        return m.bootstrap_checklist_eyebrow_next();
    }
  }

  function nextText(a: ChecklistAction): string {
    switch (a.kind) {
      case "ci-waiting":
        return m.bootstrap_checklist_next_ci_waiting();
      case "fix-ci":
        return m.bootstrap_checklist_next_ci_failed();
      case "open-session":
        return m.bootstrap_checklist_next_running();
      case "start-bootstrap":
        return a.phase >= 3
          ? m.bootstrap_checklist_next_gaps()
          : m.bootstrap_checklist_next_scaffold();
      case "start-epic":
        return m.bootstrap_checklist_next_epic();
      case "open-readiness":
        return m.bootstrap_checklist_next_exit();
    }
  }

  /** The line under the headline; empty where the headline or the exit stop already says it. */
  function detailText(a: ChecklistAction): string {
    switch (a.kind) {
      case "ci-waiting":
        return m.bootstrap_checklist_detail_ci_waiting();
      case "fix-ci":
        return m.bootstrap_checklist_detail_fixci();
      case "start-bootstrap":
        return a.phase >= 3
          ? m.bootstrap_checklist_detail_gaps()
          : m.bootstrap_checklist_detail_scaffold();
      case "start-epic":
        return m.bootstrap_checklist_detail_epic();
      case "open-session":
      case "open-readiness":
        return "";
    }
  }

  function buttonText(a: Exclude<ChecklistAction, { kind: "ci-waiting" }>): string {
    switch (a.kind) {
      case "fix-ci":
        return m.bootstrap_checklist_start_fixci();
      case "open-session":
        return m.bootstrap_checklist_open_session();
      case "start-bootstrap":
        return a.phase >= 3
          ? m.bootstrap_checklist_start_gaps()
          : m.bootstrap_checklist_start_scaffold();
      case "start-epic":
        return m.bootstrap_checklist_start_epic();
      case "open-readiness":
        return m.bootstrap_checklist_open_readiness();
    }
  }

  function run(a: Exclude<ChecklistAction, { kind: "ci-waiting" }>, adjust = false) {
    const kind = checklistStepKind(a);
    if (kind) onbootstrapstep?.(repoPath, kind, adjust);
    else if (a.kind === "open-session") onopensession?.(a.sessionId);
    else onopenreadiness?.();
  }
</script>

{#if view && action}
  {@const detail = detailText(action)}
  <section class="bsc" aria-label={m.bootstrap_checklist_title()}>
    <div class="bsc-head">
      <span class="bsc-title">{m.bootstrap_checklist_title()}</span>
      <InfoTip text={bootstrapSequencerExplanation()} label={m.bootstrap_checklist_title()} />
      <span class="bsc-hold">
        {#if view.overrideAt == null}
          <svg class="bsc-lock" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="3" y="7" width="10" height="7" rx="1" />
            <path d="M5 7V5a3 3 0 0 1 6 0v2" />
          </svg>
          {m.bootstrap_checklist_hold()}
        {:else}
          {m.bootstrap_checklist_hold_override()}
        {/if}
      </span>
    </div>
    <ol class="bsc-rail">
      {#each steps as step, i (step.id)}
        <li
          class={["bsc-stop", step.state]}
          aria-current={step.state === "current" || step.state === "held" ? "step" : undefined}
        >
          <span class="bsc-node" aria-hidden="true">
            {#if step.state === "done" || step.state === "held"}
              <svg viewBox="0 0 12 12"><polyline points="2.5,6.5 5,9 9.5,3.5" /></svg>
            {/if}
          </span>
          {#if i < steps.length - 1}
            <span class="bsc-link">
              {#if step.state === "held"}
                <span class={["bsc-chip", view.ciHold === "failed" && "failed"]}>
                  {view.ciHold === "failed"
                    ? m.bootstrap_checklist_chip_ci_failed()
                    : m.bootstrap_checklist_chip_ci_waiting()}
                </span>
              {/if}
              <span class="bsc-line" aria-hidden="true"></span>
            </span>
          {/if}
          <span class="bsc-badge">{badgeText(step.state)}</span>
          <span class="bsc-label">{STEP_LABEL[step.id]()}</span>
          <span
            class={["bsc-out", step.id === "exit" && mustHaves.length > 0 && !pending && "open"]}
            >{STEP_OUT[step.id]()}</span
          >
        </li>
      {/each}
    </ol>
    <div
      class={[
        "bsc-card",
        action.kind === "fix-ci" && "failed",
        action.kind === "ci-waiting" && "quiet",
      ]}
      style:--at={Math.max(at, 0)}
    >
      <span class="bsc-caret" aria-hidden="true"></span>
      <div class="bsc-card-text">
        <span class="bsc-eyebrow">{eyebrowText(action)}</span>
        <p class="bsc-headline">{nextText(action)}</p>
        {#if detail}<p class="bsc-detail">{detail}</p>{/if}
      </div>
      {#if action.kind !== "ci-waiting"}
        <div class="bsc-actions">
          <button class="gbtn primary" type="button" onclick={() => run(action)}
            >{buttonText(action)}</button
          >
          {#if stepKind}
            <button class="gbtn" type="button" onclick={() => run(action, true)}
              >{m.bootstrap_checklist_adjust()}</button
            >
          {/if}
        </div>
      {/if}
    </div>
  </section>
{/if}

<style>
  .bsc {
    flex: none;
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 12px 14px 14px;
    border-bottom: 1px solid var(--color-line);
    background: var(--color-panel);
    font-family: var(--font-mono);
  }
  .bsc-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .bsc-title {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .bsc-hold {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .bsc-lock {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
  }

  /* ── the track: one stop per phase, joined by a line (solid once the stop is done) ── */
  .bsc-rail {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .bsc-stop {
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr);
    grid-template-areas: "node link" "badge badge" "label label" "out out";
    align-items: center;
    column-gap: 8px;
    row-gap: 4px;
    min-width: 0;
    padding-right: 12px;
  }
  .bsc-node {
    grid-area: node;
    position: relative;
    box-sizing: border-box;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 2px solid var(--color-muted);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .bsc-node svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: var(--color-bg);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .done .bsc-node,
  .held .bsc-node {
    background: var(--color-muted);
  }
  .current .bsc-node {
    border-color: var(--color-amber);
    background: color-mix(in srgb, var(--color-amber) 14%, var(--color-panel));
  }
  .current .bsc-node::before {
    content: "";
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-amber);
  }
  .current .bsc-node::after {
    content: "";
    position: absolute;
    inset: -3px;
    border-radius: 50%;
    border: 1px solid var(--color-amber);
    animation: bsc-halo 2.4s ease-out infinite;
  }
  @keyframes bsc-halo {
    from {
      transform: scale(1);
      opacity: 0.7;
    }
    to {
      transform: scale(1.6);
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .current .bsc-node::after {
      animation: none;
      opacity: 0;
    }
  }
  .bsc-link {
    grid-area: link;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .bsc-line {
    flex: 1;
    border-top: 2px dashed var(--color-line-bright);
  }
  .done .bsc-line {
    border-top-style: solid;
    border-top-color: var(--color-muted);
  }
  .bsc-chip {
    flex: none;
    padding: 1px 6px;
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    font-size: var(--fs-micro);
    letter-spacing: 0.06em;
    white-space: nowrap;
    color: var(--color-amber);
  }
  .bsc-chip.failed {
    border-color: var(--color-red);
    color: var(--color-red);
  }
  .bsc-badge {
    grid-area: badge;
    margin-top: 4px;
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .current .bsc-badge {
    color: var(--color-amber);
  }
  .bsc-label {
    grid-area: label;
    font-size: var(--fs-base);
    color: var(--color-ink);
  }
  .current .bsc-label {
    color: var(--color-ink-bright);
    font-weight: 600;
  }
  .bsc-out {
    grid-area: out;
    font-size: var(--fs-meta);
    line-height: 1.4;
    color: var(--color-muted);
  }
  .bsc-out.open {
    color: var(--color-amber);
  }

  /* ── the next step, pointing up at the current stop ── */
  .bsc-card {
    --edge: color-mix(in srgb, var(--color-amber) 30%, var(--color-line));
    --fill: color-mix(in srgb, var(--color-amber) 5%, var(--color-panel));
    position: relative;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px 32px;
    padding: 12px 14px;
    border: 1px solid var(--edge);
    border-radius: 2px;
    background: var(--fill);
  }
  .bsc-card.quiet {
    --edge: var(--color-line-bright);
    --fill: var(--color-panel-2);
  }
  .bsc-card.failed {
    --edge: var(--color-red);
    --fill: var(--wash-attention);
  }
  .bsc-caret {
    position: absolute;
    top: -7px;
    left: calc(var(--at) * 25% + 4px);
    width: 12px;
    height: 12px;
    background: var(--fill);
    border-left: 1px solid var(--edge);
    border-top: 1px solid var(--edge);
    transform: rotate(45deg);
  }
  .bsc-card-text {
    flex: 1 1 360px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .bsc-eyebrow {
    font-size: var(--fs-micro);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-amber);
  }
  .quiet .bsc-eyebrow {
    color: var(--color-muted);
  }
  .failed .bsc-eyebrow {
    color: var(--color-red);
  }
  .bsc-headline {
    margin: 0;
    font-size: var(--fs-lg);
    font-weight: 500;
    line-height: 1.35;
    color: var(--color-ink-bright);
  }
  .bsc-detail {
    margin: 0;
    font-size: var(--fs-meta);
    line-height: 1.5;
    color: var(--color-muted);
  }
  .bsc-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 6px 12px;
    cursor: pointer;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
    background: color-mix(in srgb, var(--color-amber) 14%, var(--color-panel));
  }
  .failed .gbtn.primary,
  .failed .gbtn.primary:hover:not(:disabled) {
    border-color: var(--color-red);
    color: var(--color-red);
    background: transparent;
  }

  /* ── narrow panes (phones): the track runs down, the buttons fill the card ── */
  @container (max-width: 560px) {
    .bsc-rail {
      grid-template-columns: minmax(0, 1fr);
    }
    .bsc-stop {
      grid-template-areas: "node badge" "link label" "link out";
      align-items: start;
      row-gap: 2px;
      padding-right: 0;
    }
    .bsc-badge {
      margin-top: 0;
      align-self: center;
    }
    .bsc-link {
      flex-direction: column;
      align-self: stretch;
    }
    /* The card's eyebrow already says the merge waits on CI. */
    .bsc-chip {
      display: none;
    }
    .bsc-line {
      border-top: none;
      border-left: 2px dashed var(--color-line-bright);
      margin: 2px 0;
    }
    .done .bsc-line {
      border-left-style: solid;
      border-left-color: var(--color-muted);
    }
    .bsc-out {
      padding-bottom: 12px;
    }
    .bsc-caret {
      display: none;
    }
    .bsc-actions {
      width: 100%;
    }
    .bsc-actions .gbtn {
      flex: 1;
      min-height: 44px;
    }
  }
</style>
