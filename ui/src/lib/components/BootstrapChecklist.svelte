<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { repoBootstrap } from "#lib/repo-bootstrap.svelte.js";
  import { bootstrapSequencerExplanation } from "#lib/tooltips/explanations.js";
  import InfoTip from "./InfoTip.svelte";
  import { bootstrapMissingText } from "./queue-strip";
  import {
    checklistAction,
    checklistSteps,
    type ChecklistAction,
    type ChecklistStepId,
  } from "./bootstrap-checklist";

  // The Backlog's bootstrap checklist (#3112): where an active-bootstrap repo stands (P1+P2 → P3 →
  // P4 → exit) and its one next step. The server advances the phase; this only PROPOSES the next
  // attended session — the operator starts it with one click, nothing auto-spawns.
  let {
    repoPath,
    onbootstrapstep = undefined,
    onopensession = undefined,
    onopenreadiness = undefined,
  }: {
    repoPath: string;
    onbootstrapstep?: (repoPath: string, kind: "scaffold" | "gaps" | "epic") => void;
    onopensession?: (sessionId: string) => void;
    onopenreadiness?: () => void;
  } = $props();

  $effect(() => {
    void repoBootstrap.load(repoPath);
  });

  const view = $derived(repoBootstrap.viewFor(repoPath));
  const action = $derived(view ? checklistAction(view) : null);
  const missing = $derived(view ? bootstrapMissingText(view.missing.join(",")) : "");

  const STEP_LABEL: Record<ChecklistStepId, () => string> = {
    scaffold: () => m.bootstrap_checklist_step_scaffold(),
    gaps: () => m.automation_bootstrap_phase_3(),
    backlog: () => m.automation_bootstrap_phase_4(),
    exit: () => m.bootstrap_checklist_step_exit(),
  };

  function nextText(a: ChecklistAction): string {
    switch (a.kind) {
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

  function buttonText(a: ChecklistAction): string {
    switch (a.kind) {
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

  function run(a: ChecklistAction) {
    if (a.kind === "open-session") onopensession?.(a.sessionId);
    else if (a.kind === "start-bootstrap")
      onbootstrapstep?.(repoPath, a.phase >= 3 ? "gaps" : "scaffold");
    else if (a.kind === "start-epic") onbootstrapstep?.(repoPath, "epic");
    else onopenreadiness?.();
  }
</script>

{#if view && action}
  <section class="bsc" aria-label={m.bootstrap_checklist_title()}>
    <div class="bsc-head">
      <span class="bsc-title">{m.bootstrap_checklist_title()}</span>
      <InfoTip text={bootstrapSequencerExplanation()} label={m.bootstrap_checklist_title()} />
    </div>
    <ol class="bsc-steps">
      {#each checklistSteps(view.phase) as step (step.id)}
        <li
          class={["bsc-step", step.state]}
          aria-current={step.state === "current" ? "step" : undefined}
        >
          <span class="bsc-mark" aria-hidden="true"
            >{step.state === "done" ? "✓" : step.state === "current" ? "▸" : "·"}</span
          >
          {STEP_LABEL[step.id]()}
          <span class="sr-only">
            {step.state === "done"
              ? m.bootstrap_checklist_state_done()
              : step.state === "current"
                ? m.bootstrap_checklist_state_current()
                : m.bootstrap_checklist_state_todo()}
          </span>
        </li>
      {/each}
    </ol>
    <div class="bsc-next">
      <p class="bsc-note">{nextText(action)}</p>
      <button class="gbtn primary" type="button" onclick={() => run(action)}
        >{buttonText(action)}</button
      >
    </div>
    {#if missing}
      <p class="bsc-note bsc-muted">{m.automation_bootstrap_missing({ missing })}</p>
    {/if}
  </section>
{/if}

<style>
  .bsc {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--color-line);
    background: var(--color-panel);
    font-family: var(--font-mono);
  }
  .bsc-head {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .bsc-title {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .bsc-steps {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .bsc-step {
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 1px 6px;
    font-size: var(--fs-micro);
    color: var(--color-faint);
  }
  .bsc-step.done {
    color: var(--color-muted);
  }
  .bsc-step.current {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .bsc-mark {
    margin-right: 4px;
  }
  .bsc-next {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .bsc-note {
    margin: 0;
    font-size: var(--fs-meta);
    line-height: 1.4;
    color: var(--color-ink);
  }
  .bsc-muted {
    color: var(--color-muted);
  }
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
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
