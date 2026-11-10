<script lang="ts">
  import type { CompletedEpic } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { formatAgo } from "#lib/format.js";
  import { firstSafeHttpUrl } from "#lib/url.js";
  import {
    epicIssueHref,
    isSucceededEpic,
    successStamp,
    successTime,
  } from "#lib/succeeded-epics.js";
  import EpicOutcomePath from "./epic-outcome/EpicOutcomePath.svelte";
  import EpicOutcomeChildren from "./epic-outcome/EpicOutcomeChildren.svelte";
  import EpicOutcomeFacts from "./epic-outcome/EpicOutcomeFacts.svelte";

  // #3838: one finished epic — a success waiting for (or past) the operator's confirmation, or, in
  // the history, an epic closed without landing. `history` adds the completion/confirmation facts.
  let {
    epic,
    nowMs,
    history = false,
    onacknowledge,
    onackmigrations,
  }: {
    epic: CompletedEpic;
    nowMs: number;
    history?: boolean;
    /** Confirm the success; resolves false when it did not go through (the row says so). */
    onacknowledge?: (repoPath: string, parent: number) => Promise<boolean>;
    /** Pending landing-PR migrations are acknowledged together with the success (#645). */
    onackmigrations?: (repoPath: string, parent: number) => void | Promise<void>;
  } = $props();

  let open = $state(false);
  let busy = $state(false);
  let failed = $state(false);

  const number = $derived(epic.parentIssueNumber);
  const succeeded = $derived(isSucceededEpic(epic));
  const repoName = $derived(epic.repoPath.split("/").filter(Boolean).at(-1) ?? epic.repoPath);
  const total = $derived(epic.children.length);
  const included = $derived(epic.children.filter((c) => c.integrated).length);
  const at = $derived(successTime(epic));
  const issueHref = $derived(epicIssueHref(epic));
  const landingHref = $derived(firstSafeHttpUrl(epic.landingPrUrl));
  const pendingMigrations = $derived(
    epic.migrationPaths.length > 0 && epic.migrationsAckedAt == null,
  );
  const canAck = $derived(
    succeeded && epic.acknowledgedAt == null && !!(onacknowledge || onackmigrations),
  );
  const summary = $derived(
    epic.outcome === "incremental"
      ? m.succeeded_epics_short_incremental({ total })
      : epic.landingPrNumber != null
        ? m.succeeded_epics_short_landed({ done: included, total, number: epic.landingPrNumber })
        : m.succeeded_epics_short_landed_nonum({ done: included, total }),
  );
  const ackLabel = $derived(
    busy
      ? m.succeeded_epics_ack_busy()
      : pendingMigrations
        ? m.succeeded_epics_ack_migrations()
        : m.succeeded_epics_ack(),
  );

  async function acknowledge() {
    failed = false;
    busy = true;
    try {
      if (pendingMigrations) await onackmigrations?.(epic.repoPath, number);
      else if (onacknowledge) failed = !(await onacknowledge(epic.repoPath, number));
    } finally {
      busy = false;
    }
  }
</script>

{#snippet tick()}<svg viewBox="0 0 12 12" aria-hidden="true"
    ><path
      d="M2.5 6.4l2.3 2.3 4.7-5"
      fill="none"
      stroke="currentColor"
      stroke-width="2.2"
      stroke-linecap="round"
      stroke-linejoin="round"
    /></svg
  >{/snippet}

<div class="row" class:closed={!succeeded} role="region" aria-label={epic.parentTitle}>
  <button
    type="button"
    class="row-head"
    aria-expanded={open}
    aria-label={open
      ? m.integrated_epics_collapse_aria({ number })
      : m.integrated_epics_expand_aria({ number })}
    onclick={() => (open = !open)}
  >
    <span class="identity"
      ><span class="chev" class:collapsed={!open} aria-hidden="true">▾</span><span class="num"
        >{m.integrated_epics_identity({ number })}</span
      ><span class="repo" title={repoName}>{repoName}</span>{#if succeeded}<span class="ago"
          >{m.succeeded_epics_ago({ ago: formatAgo(nowMs - at) })}</span
        >{/if}</span
    >
    <span class="epic-title" class:expanded={open}>{epic.parentTitle}</span>
  </button>

  <div class="status">
    {#if succeeded}
      <span class="outcome-chip"
        ><span class="mark">{@render tick()}</span>{m.succeeded_epics_chip()}</span
      >
      <time class="stamp" datetime={new Date(at).toISOString()}>{successStamp(at)}</time>
    {:else}
      <span class="outcome-chip unlanded"
        ><span class="mark" aria-hidden="true">–</span>{m.epic_history_closed_chip()}</span
      >
    {/if}
  </div>

  {#if history}
    <EpicOutcomeFacts {epic} />
    {#if !succeeded}<p class="note">{m.epic_history_closed_body()}</p>{/if}
  {:else if !open}
    <p class="note">{summary}</p>
  {/if}

  {#if open}
    {#if succeeded}<EpicOutcomePath {epic} {nowMs} />{/if}
    <div class="links">
      <!-- eslint-disable svelte/no-navigation-without-resolve -- external forge URLs -->
      {#if issueHref}<a class="gbtn" href={issueHref} target="_blank" rel="noopener noreferrer"
          >{m.integrated_epics_open_issue()}</a
        >{/if}
      {#if landingHref}<a class="gbtn" href={landingHref} target="_blank" rel="noopener noreferrer"
          >{m.integrated_epics_open_pr()}</a
        >{/if}
      <!-- eslint-enable svelte/no-navigation-without-resolve -->
    </div>
    {#if total > 0}<EpicOutcomeChildren children={epic.children} />{/if}
  {/if}

  {#if canAck}
    {#if pendingMigrations}<p class="warn">
        {m.epic_migrations_pending({ count: epic.migrationPaths.length })}
      </p>{/if}
    <div class="actions">
      <button
        class="gbtn primary"
        type="button"
        disabled={busy}
        aria-busy={busy}
        onclick={acknowledge}>{@render tick()}{ackLabel}</button
      >
      <span class="note">{m.succeeded_epics_ack_hint()}</span>
    </div>
    {#if failed}<p class="warn" role="alert">{m.succeeded_epics_ack_failed()}</p>{/if}
  {/if}
</div>

<style>
  .row {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
    padding: 10px;
    border: 1px solid color-mix(in srgb, var(--status-done) 60%, var(--color-line));
    background: color-mix(in srgb, var(--status-done) 6%, var(--color-panel));
    font-size: var(--fs-meta);
  }
  .row.closed {
    border-color: var(--color-line);
    background: none;
  }
  .row-head {
    display: flex;
    flex-direction: column;
    gap: 7px;
    width: 100%;
    min-width: 0;
    padding: 0;
    border: 0;
    background: none;
    color: var(--color-muted);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .row-head:focus-visible,
  .gbtn:focus-visible {
    outline: 2px solid var(--color-ink-bright);
    outline-offset: 2px;
  }
  .identity {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-width: 0;
    font-size: var(--fs-micro);
  }
  .chev,
  .num,
  .ago {
    flex: none;
  }
  .chev {
    transition: transform 0.12s ease;
  }
  .chev.collapsed {
    transform: rotate(-90deg);
  }
  .num,
  .repo,
  .stamp {
    font-family: var(--font-mono);
  }
  .repo {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .epic-title {
    display: -webkit-box;
    -webkit-line-clamp: 1;
    line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
    width: 100%;
    font-size: var(--fs-base);
    line-height: 1.4;
    color: var(--color-ink-bright);
  }
  .epic-title.expanded {
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  /* Slate, not green: green means "act now" (READY); a success to acknowledge is finished-but-
     parked. The tick, the wording and the fully ticked path carry the success. */
  .outcome-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px 3px 4px;
    border: 1px solid var(--status-done);
    border-radius: var(--radius-chip);
    background: color-mix(in srgb, var(--status-done) 24%, transparent);
    color: var(--color-ink-bright);
    font-size: var(--fs-micro);
    font-weight: 600;
    letter-spacing: 0.05em;
  }
  .outcome-chip .mark {
    display: grid;
    place-items: center;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--color-ink-bright);
    color: var(--color-panel);
  }
  .outcome-chip .mark svg {
    width: 9px;
    height: 9px;
  }
  .outcome-chip.unlanded {
    border-style: dashed;
    border-color: var(--color-line-bright);
    background: none;
    color: var(--color-ink);
    font-weight: 400;
  }
  .outcome-chip.unlanded .mark {
    box-sizing: border-box;
    border: 1px solid var(--color-muted);
    background: none;
    color: var(--color-muted);
  }
  .stamp {
    font-size: var(--fs-micro);
    color: var(--color-ink);
  }
  .note {
    margin: 0;
    font-size: var(--fs-micro);
    line-height: 1.5;
    color: var(--color-muted);
  }
  .links,
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .links:empty {
    display: none;
  }
  .gbtn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    background: transparent;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    text-decoration: none;
    cursor: pointer;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn.primary {
    border-color: var(--color-action-quiet);
    background: var(--color-action-quiet);
    color: var(--color-on-quiet-action);
    font-weight: 600;
  }
  .gbtn.primary:hover:not(:disabled) {
    border-color: var(--color-ink-bright);
    color: var(--color-on-quiet-action);
  }
  .gbtn.primary svg {
    width: 11px;
    height: 11px;
  }
  .gbtn:disabled {
    border-style: dashed;
    cursor: progress;
  }
  .warn {
    margin: 0;
    font-size: var(--fs-micro);
    line-height: 1.5;
    color: var(--status-warn);
  }
  @media (pointer: coarse) {
    .row-head,
    .gbtn {
      min-height: 44px;
    }
  }
</style>
