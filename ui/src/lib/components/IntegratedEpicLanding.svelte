<script lang="ts">
  import type { Snippet } from "svelte";
  import type { CompletedEpic } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { coachTarget } from "#lib/actions/coachTarget.svelte.js";
  import { deriveIntegratedEpicStatus } from "#lib/integrated-epic-status.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import {
    landingCiRepairExplanation,
    landingConflictReworkExplanation,
  } from "#lib/tooltips/explanations.js";
  import GlossaryText from "./GlossaryText.svelte";
  import LandingCiStatus from "./LandingCiStatus.svelte";

  let {
    epic,
    onland,
    ondismiss,
    onackmigrations,
    onresolveconflicts = () => {},
    onrepairci = async () => true,
    onopensession = () => {},
    nowMs = Date.now(),
    children,
  }: {
    epic: CompletedEpic;
    onland: (repoPath: string, parent: number) => void;
    ondismiss: (repoPath: string, parent: number) => void;
    onackmigrations: (repoPath: string, parent: number) => void;
    onresolveconflicts?: (repoPath: string, parent: number) => void;
    /** #2872: start a CI-repair agent; resolves false when it could not be started. */
    onrepairci?: (repoPath: string, parent: number) => Promise<boolean>;
    onopensession?: (id: string) => void;
    nowMs?: number;
    children?: Snippet;
  } = $props();
  let confirming = $state(false);
  let repairStarting = $state(false);
  let repairFailed = $state(false);
  const status = $derived(deriveIntegratedEpicStatus(epic, confirming));
  const total = $derived(epic.children.length);
  const included = $derived(epic.children.filter((c) => c.integrated).length);
  const pendingAck = $derived(epic.migrationPaths.length > 0 && epic.migrationsAckedAt == null);
  const ackInstead = $derived(epic.landingState !== "open" && pendingAck);
  const fieldRemoval = $derived(
    status.situation === "nothing-to-land" || status.situation === "landed",
  );
  const reasonId = $props.id();
  const parentUrl = $derived.by(() => {
    const ref = epic.children.find((c) => c.url)?.url;
    return ref ? ref.replace(/\/\d+(?=\/?$)/, `/${epic.parentIssueNumber}`) : null;
  });
  const checksUrl = $derived(
    epic.landingPrUrl ? `${epic.landingPrUrl.replace(/\/$/, "")}/checks` : null,
  );
  const checking = $derived(epic.landingChecks === "pending" || epic.landingMergeable === null);
  // #2872: the live repair session, else the last recorded one (server omits archived sessions).
  const repairSessionId = $derived(epic.landingCiAutomation?.repair.sessionId ?? null);
  const showCiStatus = $derived(
    status.situation === "ci-failed" ||
      status.situation === "ci-retrying" ||
      (status.situation === "repairing" && status.repairKind === "ci"),
  );
  const paused = $derived.by(() => {
    switch (epic.landingRebasePauseReason) {
      case "cap":
        return m.integrated_epics_rebase_paused_cap();
      case "conflict":
        return m.integrated_epics_rebase_paused_conflict();
      case "driver":
        return m.integrated_epics_rebase_paused_driver();
      default:
        return null;
    }
  });
  const copy = $derived.by(() => {
    const number = epic.landingPrNumber;
    const bySituation = {
      preparing: () => ({
        heading: m.integrated_epics_heading_preparing(),
        body: m.integrated_epics_body_preparing(),
        label: m.integrated_epics_status_preparing(),
        reason: "",
      }),
      checking: () => ({
        heading:
          checking && number != null
            ? m.integrated_epics_heading_checking({ number })
            : m.integrated_epics_heading_unknown(),
        body: checking ? m.integrated_epics_body_checking() : m.integrated_epics_body_unknown(),
        label: checking
          ? m.integrated_epics_status_checking()
          : m.integrated_epics_status_unknown(),
        reason: checking
          ? m.integrated_epics_land_not_ready_computing()
          : m.integrated_epics_land_not_ready_generic(),
      }),
      repairing: () => ({
        heading:
          status.repairKind === "conflicts"
            ? m.integrated_epics_heading_repairing_conflicts()
            : m.integrated_epics_heading_repairing_ci(),
        body:
          status.repairKind === "conflicts"
            ? m.integrated_epics_body_repairing_conflicts()
            : m.integrated_epics_body_repairing_ci(),
        label: m.integrated_epics_status_repairing(),
        reason: m.integrated_epics_land_not_ready_repairing(),
      }),
      "ci-retrying": () => ({
        heading:
          status.ciRetrying === "repair"
            ? m.integrated_epics_heading_ci_retrying_repair()
            : m.integrated_epics_heading_ci_retrying_reruns(),
        body:
          status.ciRetrying === "repair"
            ? m.integrated_epics_body_ci_retrying_repair()
            : m.integrated_epics_body_ci_retrying_reruns(),
        label: m.integrated_epics_status_ci_retrying(),
        reason: m.integrated_epics_land_not_ready_ci_failing(),
      }),
      "ci-failed": () => ({
        heading:
          status.ciVariant === "after-repair"
            ? m.integrated_epics_heading_ci_after_repair()
            : number != null
              ? m.integrated_epics_heading_ci_failed({ number })
              : m.integrated_epics_heading_ci_failed_nonum(),
        body:
          status.ciVariant === "after-repair"
            ? m.integrated_epics_body_ci_after_repair()
            : status.ciVariant === "drain-off"
              ? m.integrated_epics_body_ci_drain_off()
              : m.integrated_epics_body_ci_exhausted(),
        label: m.integrated_epics_status_ci_failed(),
        reason: m.integrated_epics_land_not_ready_ci_failing(),
      }),
      conflicts: () => ({
        heading:
          paused ??
          (number != null
            ? m.integrated_epics_heading_conflicts({ number })
            : m.integrated_epics_heading_conflicts_nonum()),
        body: status.canResolveConflicts
          ? m.integrated_epics_body_conflicts()
          : m.integrated_epics_body_paused(),
        label: paused ? m.integrated_epics_status_paused() : m.integrated_epics_status_conflicts(),
        reason: status.canResolveConflicts
          ? m.integrated_epics_land_not_ready_conflicts()
          : m.integrated_epics_land_not_ready_generic(),
      }),
      "nothing-to-land": () => ({
        heading: m.integrated_epics_heading_none(),
        body:
          included === 0
            ? m.integrated_epics_body_nothing_merged({ number: epic.parentIssueNumber })
            : m.integrated_epics_body_nothing_left(),
        label: m.integrated_epics_status_none(),
        reason: "",
      }),
      ready: () => ({
        heading: m.integrated_epics_heading_ready(),
        body: m.integrated_epics_body_ready({ pr: number!, number: epic.parentIssueNumber }),
        label: m.integrated_epics_status_ready(),
        reason: "",
      }),
      confirming: () => ({
        heading: m.integrated_epics_land_confirm_prompt({ number: number! }),
        body: m.integrated_epics_land_confirm_body({
          count: included,
          number: epic.parentIssueNumber,
        }),
        label: m.integrated_epics_status_ready(),
        reason: "",
      }),
      landed: () => ({
        heading: m.integrated_epics_path_landed(),
        body:
          number != null
            ? m.integrated_epics_body_landed({ pr: number, number: epic.parentIssueNumber })
            : m.integrated_epics_body_landed_nonum(),
        label: m.integrated_epics_status_merged(),
        reason: "",
      }),
      error: () => ({
        heading: m.integrated_epics_landing_failed(),
        body: m.integrated_epics_body_error(),
        label: m.integrated_epics_status_error(),
        reason: "",
      }),
      "not-ready": () => ({
        heading: m.integrated_epics_heading_not_ready(),
        body: m.integrated_epics_body_not_ready(),
        label: m.integrated_epics_status_not_ready(),
        reason: m.integrated_epics_land_not_ready_generic(),
      }),
    };
    return bySituation[status.situation]();
  });
  const landingMarker = $derived(
    status.canLand
      ? "ready"
      : status.situation === "landed"
        ? "done"
        : status.situation === "ci-failed"
          ? "failure"
          : status.situation === "conflicts" || status.situation === "error"
            ? "warn"
            : ["preparing", "checking", "repairing", "ci-retrying"].includes(status.situation)
              ? "running"
              : "open",
  );
  const steps = $derived([
    {
      label: m.integrated_epics_path_tasks(),
      value: `${total}/${total}`,
      detail: m.integrated_epics_path_counts({ included, excluded: total - included }),
      marker: "done",
      href: null,
    },
    {
      label: m.integrated_epics_path_collected(),
      value: m.integrated_epics_path_pr_count({ count: included }),
      detail: epic.integrationBranch ?? m.integrated_epics_path_branch_unknown(),
      marker: included > 0 ? "done" : "open",
      href: null,
    },
    {
      label:
        epic.landingPrNumber != null
          ? m.integrated_epics_path_landing({ number: epic.landingPrNumber })
          : m.integrated_epics_path_landing_nonum(),
      value: copy.label,
      detail: "",
      marker: landingMarker,
      href: epic.landingPrUrl,
    },
    {
      label: m.integrated_epics_path_landed(),
      value: "",
      detail: "",
      marker: status.situation === "landed" ? "done" : "open",
      href: null,
    },
  ]);
  $effect(() => {
    if (!status.canLand) confirming = false;
  });
  $effect(() => {
    if (!status.canRepairCi) repairFailed = false;
  });
  async function handleRepairCi() {
    repairFailed = false;
    repairStarting = true;
    try {
      repairFailed = !(await onrepairci(epic.repoPath, epic.parentIssueNumber));
    } finally {
      repairStarting = false;
    }
  }
  function handleLandConfirm() {
    if (!deriveIntegratedEpicStatus(epic).canLand) return;
    confirming = false;
    onland(epic.repoPath, epic.parentIssueNumber);
  }
</script>

<div class="landing" class:ready={status.tone === "ready"} class:warn={status.tone === "warn"}>
  <section class="path" aria-label={m.integrated_epics_path_heading()}>
    <h4>{m.integrated_epics_path_heading()}</h4>
    <ol class="landing-path">
      {#each steps as step, i (i)}
        <li>
          <span class="marker {step.marker}" aria-hidden="true"
            >{step.marker === "done" ? "✓" : ""}</span
          >
          <div class="step-content">
            <div class="step-line">
              {#if step.href}
                <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
                <a href={step.href} target="_blank" rel="noopener noreferrer">{step.label}</a>
              {:else}<span>{step.label}</span>{/if}
              <span class="step-value">{step.value}</span>
            </div>
            {#if step.detail}<div class="step-detail">{step.detail}</div>{/if}
          </div>
        </li>
      {/each}
    </ol>
  </section>

  <section class="next-step" aria-label={m.integrated_epics_next_heading()}>
    <h4>{m.integrated_epics_next_heading()}</h4>
    <h3 use:coachTarget={epic.landingRebasePauseReason ? "rebase-paused-chip" : ""}>
      {copy.heading}
    </h3>
    <p><GlossaryText text={copy.body} /></p>
    {#if showCiStatus}<LandingCiStatus {epic} {nowMs} {onopensession} />{/if}
    {#if status.situation === "confirming" && pendingAck}
      <p class="migration-warn">
        {m.integrated_epics_land_confirm_migration_warn({ count: epic.migrationPaths.length })}
      </p>
    {/if}
    <div class="actions">
      {#if status.situation === "confirming"}
        <button class="gbtn primary" type="button" onclick={handleLandConfirm}
          >{m.integrated_epics_land_confirm()}</button
        >
        <button class="gbtn" type="button" onclick={() => (confirming = false)}
          >{m.common_cancel()}</button
        >
      {:else if status.situation === "ready"}
        <button class="gbtn primary" type="button" onclick={() => (confirming = true)}
          >{m.integrated_epics_land()}</button
        >
      {:else if status.canRepairCi}
        <!-- #2872: primary once nothing automatic is left; secondary while Shepherd still retries. -->
        <button
          class="gbtn"
          class:primary={status.situation === "ci-failed"}
          type="button"
          disabled={repairStarting}
          use:statusTip={{ text: landingCiRepairExplanation(), stopClickPropagation: false }}
          onclick={handleRepairCi}
          >{status.ciVariant === "after-repair"
            ? m.integrated_epics_repair_ci_again()
            : m.integrated_epics_repair_ci()}</button
        >
        {#if status.ciVariant === "after-repair" && repairSessionId}
          <button class="gbtn" type="button" onclick={() => onopensession(repairSessionId)}
            >{m.integrated_epics_last_session()}</button
          >
        {/if}
        {#if checksUrl}
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
          <a class="gbtn" href={checksUrl} target="_blank" rel="noopener noreferrer"
            >{m.integrated_epics_view_checks()}</a
          >
        {/if}
      {:else if (status.situation === "ci-retrying" || status.situation === "ci-failed") && checksUrl}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
        <a class="gbtn" href={checksUrl} target="_blank" rel="noopener noreferrer"
          >{m.integrated_epics_view_checks()}</a
        >
      {:else if status.situation === "repairing" && repairSessionId}
        <button class="gbtn" type="button" onclick={() => onopensession(repairSessionId)}
          >{m.integrated_epics_open_session()}</button
        >
      {:else if status.situation === "conflicts" && status.canResolveConflicts}
        <button
          class="gbtn primary"
          type="button"
          use:statusTip={{ text: landingConflictReworkExplanation(), stopClickPropagation: false }}
          onclick={() => onresolveconflicts(epic.repoPath, epic.parentIssueNumber)}
          >{m.integrated_epics_resolve_conflicts()}</button
        >
      {:else if status.situation === "nothing-to-land" && parentUrl}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
        <a class="gbtn primary" href={parentUrl} target="_blank" rel="noopener noreferrer"
          >{m.integrated_epics_open_issue()}</a
        >
      {:else if status.situation === "not-ready" && epic.landingPrUrl}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
        <a class="gbtn primary" href={epic.landingPrUrl} target="_blank" rel="noopener noreferrer"
          >{m.integrated_epics_open_pr()}</a
        >
      {/if}
      {#if epic.landingState === "open" && !status.canLand}
        <div class="locked-action">
          <button class="gbtn land" type="button" disabled aria-describedby={reasonId}>
            <svg
              class="lock"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              aria-hidden="true"
              ><rect x="3" y="7" width="10" height="7" rx="1" /><path
                d="M5 7V4a3 3 0 0 1 6 0v3"
              /></svg
            >{m.integrated_epics_land()}
          </button>
          <span class="blocked-reason" id={reasonId}>{copy.reason}</span>
        </div>
      {/if}
      {#if ackInstead}
        <button
          class="gbtn primary"
          type="button"
          onclick={() => onackmigrations(epic.repoPath, epic.parentIssueNumber)}
          >{m.integrated_epics_ack_migrations()}</button
        >
      {:else if fieldRemoval}
        <button
          class="gbtn"
          class:primary={status.situation === "landed"}
          type="button"
          onclick={() => ondismiss(epic.repoPath, epic.parentIssueNumber)}
          >{m.integrated_epics_dismiss()}</button
        >
      {/if}
    </div>
    {#if status.canRepairCi}<p class="remove-hint">{m.integrated_epics_repair_ci_hint()}</p>{/if}
    {#if repairFailed}<p class="migration-warn" role="alert">
        {m.integrated_epics_repair_ci_failed()}
      </p>{/if}
    {#if ackInstead}<p class="migration-warn">
        {m.epic_migrations_pending({ count: epic.migrationPaths.length })}
      </p>{/if}
    {#if fieldRemoval && !ackInstead}<p class="remove-hint">
        {m.integrated_epics_dismiss_hint()}
      </p>{/if}
  </section>

  {@render children?.()}

  {#if !fieldRemoval && !ackInstead && status.situation !== "confirming"}
    <footer>
      <button
        class="gbtn"
        type="button"
        onclick={() => ondismiss(epic.repoPath, epic.parentIssueNumber)}
        >{m.integrated_epics_dismiss()}</button
      >
      <span class="remove-hint">{m.integrated_epics_dismiss_hint()}</span>
    </footer>
  {/if}
</div>

<style>
  .landing {
    --epic-tone: var(--status-done);
    --epic-fill: var(--color-action-quiet);
    --epic-button-ink: var(--color-on-quiet-action);
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  .landing.warn {
    --epic-tone: var(--status-warn);
    --epic-fill: var(--status-warn);
    --epic-button-ink: var(--color-on-action);
  }
  .landing.ready {
    --epic-tone: var(--color-green);
    --epic-fill: var(--color-action-ready);
    --epic-button-ink: var(--color-on-action);
  }
  h4 {
    margin: 0 0 8px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  h3 {
    margin: 0;
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  p {
    margin: 6px 0 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.5;
  }
  .landing-path {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .landing-path li {
    display: flex;
    gap: 8px;
    padding-bottom: 12px;
    position: relative;
  }
  .landing-path li:last-child {
    padding-bottom: 0;
  }
  .landing-path li:not(:last-child)::before {
    content: "";
    position: absolute;
    left: 7px;
    top: 16px;
    bottom: 0;
    width: 1px;
    background: var(--color-line);
  }
  .marker {
    flex: none;
    width: 15px;
    height: 15px;
    display: grid;
    place-items: center;
    border: 1px solid var(--color-line-bright);
    border-radius: 50%;
    font-size: var(--fs-micro);
    color: var(--status-done);
  }
  .marker.done {
    border-color: var(--status-done);
  }
  .marker.running {
    background: var(--color-amber);
    border-color: var(--color-amber);
  }
  .marker.failure {
    background: var(--color-red);
    border-color: var(--color-red);
  }
  .marker.warn {
    background: var(--status-warn);
    border-color: var(--status-warn);
  }
  .marker.ready {
    background: var(--color-green);
    border-color: var(--color-green);
  }
  .step-content {
    flex: 1;
    min-width: 0;
  }
  .step-line {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: baseline;
    gap: 6px;
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  .step-line a {
    color: inherit;
    text-decoration: none;
  }
  .step-line a:hover {
    text-decoration: underline;
    color: var(--color-ink-bright);
  }
  .step-value,
  .step-detail {
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
  .step-detail {
    margin-top: 3px;
    overflow-wrap: anywhere;
  }
  .next-step {
    border: 1px solid color-mix(in srgb, var(--epic-tone) 55%, var(--color-line));
    background: color-mix(in srgb, var(--epic-tone) 7%, transparent);
    padding: 10px;
    min-width: 0;
  }
  .actions,
  footer,
  .locked-action {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .actions:not(:empty) {
    margin-top: 10px;
  }
  .blocked-reason,
  .remove-hint {
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
  .migration-warn {
    color: var(--status-warn);
  }
  .gbtn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 4px 8px;
    cursor: pointer;
    text-decoration: none;
    text-align: left;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: 2px solid var(--color-ink-bright);
    outline-offset: 2px;
  }
  .gbtn.primary {
    background: var(--epic-fill);
    border-color: var(--epic-fill);
    color: var(--epic-button-ink);
    font-weight: 600;
  }
  .gbtn.primary:hover {
    color: var(--epic-button-ink);
    border-color: var(--color-ink-bright);
  }
  .gbtn:disabled {
    border-style: dashed;
    cursor: not-allowed;
  }
  .lock {
    width: 1em;
    height: 1em;
    flex: none;
  }
  @media (pointer: coarse) {
    .gbtn {
      min-height: 44px;
    }
  }
</style>
