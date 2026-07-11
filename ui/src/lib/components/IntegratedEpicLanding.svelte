<script lang="ts">
  import type { CompletedEpic } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { formatAgo } from "$lib/format";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import { deriveFooterSituation } from "$lib/integrated-epic-status";

  let {
    epic,
    nowMs = Date.now(),
    onland,
    ondismiss,
    onackmigrations,
  }: {
    epic: CompletedEpic;
    nowMs?: number;
    onland: (repoPath: string, parent: number) => void;
    ondismiss: (repoPath: string, parent: number) => void;
    onackmigrations: (repoPath: string, parent: number) => void;
  } = $props();

  let confirming = $state(false);

  const migrationCount = $derived(epic.migrationPaths.length);
  const pendingAck = $derived(migrationCount > 0 && epic.migrationsAckedAt == null);

  const parentUrl = $derived.by(() => {
    const ref = epic.children.find((c) => c.url)?.url;
    if (!ref) return null;
    return ref.replace(/\/\d+(?=\/?$)/, `/${epic.parentIssueNumber}`);
  });

  const isOpen = $derived(epic.landingState === "open");

  // Plain-language footer line for the non-open, non-merged, non-error states (pending / none).
  // Reflects the real landing state so the band can't claim "awaiting landing" when there is
  // nothing to land (the defect this fixes). merged/error/open keep their own dedicated lines,
  // so footerText is null for them and the template falls through to those branches.
  const total = $derived(epic.children.length);
  const footerText = $derived.by((): string | null => {
    switch (deriveFooterSituation(epic)) {
      case "opening":
        return m.integrated_epics_footer_opening();
      case "nothing-merged":
        return m.integrated_epics_footer_nothing_merged({ total, number: epic.parentIssueNumber });
      case "nothing-to-land":
        return m.integrated_epics_footer_nothing_to_land({ number: epic.parentIssueNumber });
      default:
        return null;
    }
  });

  const rebasePausedLabel = $derived.by((): string | null => {
    if (!epic.landingRebasePauseReason) return null;
    if (epic.landingRebasePauseReason === "cap") return m.integrated_epics_rebase_paused_cap();
    if (epic.landingRebasePauseReason === "conflict")
      return m.integrated_epics_rebase_paused_conflict();
    if (epic.landingRebasePauseReason === "driver")
      return m.integrated_epics_rebase_paused_driver();
    return null;
  });

  const landNotReadyReason = $derived.by((): string => {
    if (epic.landingChecks === "failure") return m.integrated_epics_land_not_ready_ci_failing();
    if (epic.landingChecks === "pending" || epic.landingMergeable === null)
      return m.integrated_epics_land_not_ready_computing();
    if (epic.landingMergeable === false) return m.integrated_epics_land_not_ready_conflicts();
    return m.integrated_epics_land_not_ready_generic();
  });

  function handleLandConfirm() {
    confirming = false;
    onland(epic.repoPath, epic.parentIssueNumber);
  }
</script>

<div class="actions">
  {#if isOpen}
    <!-- open state: Land CTA (+ Dismiss); Ack-migrations path suppressed here to avoid
         silently clearing an unlanded epic (the bug #1039 fixes). Migration advisory
         moves into the Land confirm step instead. -->
    {#if epic.landingPrNumber != null}
      {#if confirming}
        <span class="confirm-prompt">
          {m.integrated_epics_land_confirm_prompt()}
          {#if pendingAck}
            <span class="confirm-migration-warn"
              >{m.integrated_epics_land_confirm_migration_warn({
                count: migrationCount,
              })}</span
            >
          {/if}
        </span>
        <button class="gbtn gbtn-primary" type="button" onclick={handleLandConfirm}>
          {m.integrated_epics_land_confirm()}
        </button>
        <button class="gbtn" type="button" onclick={() => (confirming = false)}>
          {m.common_cancel()}
        </button>
      {:else}
        {#if epic.landingStranded}
          <span class="chip-stranded"
            >{m.integrated_epics_land_stranded({
              ago: formatAgo(nowMs - epic.completedAt),
            })}</span
          >
        {/if}
        {#if epic.landingRepairing}
          <!-- Non-actionable: an auto-repair session is live, driving CI back to green. -->
          <span class="chip-repairing">{m.integrated_epics_auto_repairing()}</span>
        {/if}
        {#if epic.landingReady === true}
          <button class="gbtn" type="button" onclick={() => (confirming = true)}>
            {m.integrated_epics_land()}
          </button>
        {:else}
          <button
            class="gbtn"
            type="button"
            disabled
            title={landNotReadyReason}
            aria-disabled="true"
          >
            {m.integrated_epics_land()}
          </button>
        {/if}
      {/if}
    {/if}
    <!-- Always show Dismiss in open state (explicit operator hide) -->
    {#if !confirming}
      <button
        class="gbtn"
        type="button"
        title={m.integrated_epics_dismiss()}
        onclick={() => ondismiss(epic.repoPath, epic.parentIssueNumber)}
      >
        {m.integrated_epics_dismiss()}
      </button>
    {/if}
    {#if epic.landingPrUrl}
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
      <a class="awaiting" href={epic.landingPrUrl} target="_blank" rel="noopener noreferrer"
        >{m.integrated_epics_landing_pr({ number: epic.landingPrNumber! })}</a
      >
    {:else if epic.landingPrNumber != null}
      <span class="awaiting">{m.integrated_epics_landing_pr({ number: epic.landingPrNumber })}</span
      >
    {/if}
  {:else if pendingAck && epic.landingState !== "open"}
    <!-- legacy/rare Ack-migrations path: only for non-open states with pending migrations -->
    <span class="chip-migrations" title={m.epic_migrations_pending({ count: migrationCount })}>
      {m.epic_migrations_pending({ count: migrationCount })}
    </span>
    <button
      class="gbtn"
      type="button"
      title={m.integrated_epics_ack_migrations()}
      onclick={() => onackmigrations(epic.repoPath, epic.parentIssueNumber)}
    >
      {m.integrated_epics_ack_migrations()}
    </button>
  {:else if epic.landingState !== "open"}
    <button
      class="gbtn"
      type="button"
      title={m.integrated_epics_dismiss()}
      onclick={() => ondismiss(epic.repoPath, epic.parentIssueNumber)}
    >
      {m.integrated_epics_dismiss()}
    </button>
  {/if}
  {#if rebasePausedLabel}
    <span class="chip-rebase-paused" use:coachTarget={"rebase-paused-chip"}
      >{rebasePausedLabel}</span
    >
  {/if}
  {#if !isOpen}
    {#if epic.landingState === "merged" && epic.landingPrNumber != null}
      {#if epic.landingPrUrl}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
        <a class="awaiting" href={epic.landingPrUrl} target="_blank" rel="noopener noreferrer"
          >{m.integrated_epics_landing_pr_merged({ number: epic.landingPrNumber })}</a
        >
      {:else}
        <span class="awaiting"
          >{m.integrated_epics_landing_pr_merged({ number: epic.landingPrNumber })}</span
        >
      {/if}
    {:else if epic.landingState === "error"}
      <span class="landing-failed">{m.integrated_epics_landing_failed()}</span>
    {:else if footerText}
      {#if parentUrl}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
        <a class="awaiting" href={parentUrl} target="_blank" rel="noopener noreferrer"
          >{footerText}</a
        >
      {:else}
        <span class="awaiting">{footerText}</span>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 2px 8px 6px;
  }
  /* Quiet/muted "parent still open" note. */
  .awaiting {
    color: var(--color-faint);
    font-size: var(--fs-micro);
    text-decoration: none;
  }
  a.awaiting:hover {
    color: var(--color-muted);
    text-decoration: underline;
  }
  /* Quiet warning note — landing PR couldn't be opened (no link yet). */
  .landing-failed {
    color: var(--status-warn);
    font-size: var(--fs-micro);
  }

  /* Warning-tone chip — unrun migrations need operator verification before clearing the row.
     Warn = caution (NOT success-green); mirrors the .badge recipe with the warn hue. */
  .chip-migrations {
    flex: none;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    padding: 1px 6px;
    border: 1px solid var(--status-warn);
    border-radius: 2px;
    color: var(--status-warn);
    background: color-mix(in oklab, var(--status-warn) 12%, transparent);
  }

  /* Stranded escalation badge — open+unlanded past 6h threshold */
  .chip-stranded {
    flex: none;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    padding: 1px 6px;
    border: 1px solid var(--status-warn);
    border-radius: 2px;
    color: var(--status-warn);
    background: color-mix(in oklab, var(--status-warn) 12%, transparent);
    text-transform: uppercase;
  }

  /* Slate "in progress, non-actionable" chip — an auto-repair session is live driving CI back to
     green. NEVER green (reserved for READY) and NEVER the warn hue (no operator action needed);
     mirrors the .chip-done slate recipe used elsewhere for quiet/parked states. */
  .chip-repairing {
    flex: none;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    padding: 1px 6px;
    border: 1px solid var(--status-done);
    border-radius: 2px;
    color: var(--status-done);
    background: color-mix(in oklab, var(--status-done) 12%, transparent);
    text-transform: uppercase;
  }

  /* Warn-tone chip — auto-rebase pass paused, operator action needed (#1071).
     Same token recipe as chip-migrations; distinct from .landing-failed (which is error-only). */
  .chip-rebase-paused {
    flex: none;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    padding: 1px 6px;
    border: 1px solid var(--status-warn);
    border-radius: 2px;
    color: var(--status-warn);
    background: color-mix(in oklab, var(--status-warn) 12%, transparent);
  }

  /* Inline confirm step — prompt text + migration warning */
  .confirm-prompt {
    font-size: var(--fs-micro);
    color: var(--color-muted);
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .confirm-migration-warn {
    color: var(--status-warn);
  }

  /* Canonical .gbtn recipe (scoped per-component; see /design-system). */
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
    transition:
      border-color 0.12s,
      color 0.12s;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  /* Primary confirm button — slightly elevated */
  .gbtn-primary {
    border-color: var(--status-warn);
    color: var(--status-warn);
  }
  .gbtn-primary:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
</style>
