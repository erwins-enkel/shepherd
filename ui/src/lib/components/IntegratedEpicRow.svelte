<script lang="ts">
  import type { CompletedEpic } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { formatAgo } from "$lib/format";
  import { deriveIntegratedEpicStatus } from "$lib/integrated-epic-status";
  import IntegratedEpicLanding from "./IntegratedEpicLanding.svelte";
  let {
    epic,
    ondismiss,
    onackmigrations,
    onland,
    onresolveconflicts = () => {},
    nowMs = Date.now(),
  }: {
    epic: CompletedEpic;
    nowMs?: number;
    ondismiss: (repoPath: string, parent: number) => void;
    onackmigrations: (repoPath: string, parent: number) => void;
    onland: (repoPath: string, parent: number) => void;
    onresolveconflicts?: (repoPath: string, parent: number) => void;
  } = $props();
  let open = $state(false);
  let childrenOpen = $state(false);
  const repoName = $derived(epic.repoPath.split("/").filter(Boolean).at(-1) ?? epic.repoPath);
  const total = $derived(epic.children.length);
  const included = $derived(epic.children.filter((c) => c.integrated).length);
  const status = $derived(deriveIntegratedEpicStatus(epic));
  const turnLabel = $derived(
    {
      "nothing-to-do": m.integrated_epics_turn_nothing(),
      "your-turn": m.integrated_epics_turn_you(),
      ready: m.integrated_epics_turn_ready(),
      done: m.integrated_epics_turn_done(),
    }[status.turn],
  );
  const summary = $derived.by(() => {
    const number = epic.landingPrNumber;
    switch (status.situation) {
      case "preparing":
        return m.integrated_epics_short_preparing();
      case "checking":
        return number != null &&
          (epic.landingChecks === "pending" || epic.landingMergeable === null)
          ? m.integrated_epics_short_checking({ number })
          : m.integrated_epics_heading_unknown();
      case "repairing":
        return status.repairKind === "conflicts"
          ? m.integrated_epics_heading_repairing_conflicts()
          : m.integrated_epics_heading_repairing_ci();
      case "ci-failed":
        return number != null
          ? m.integrated_epics_short_ci_failed({ number })
          : m.integrated_epics_heading_ci_failed_nonum();
      case "conflicts":
        if (epic.landingRebasePauseReason === "cap") return m.integrated_epics_rebase_paused_cap();
        if (epic.landingRebasePauseReason === "driver")
          return m.integrated_epics_rebase_paused_driver();
        return number != null
          ? m.integrated_epics_short_conflicts({ number })
          : m.integrated_epics_heading_conflicts_nonum();
      case "nothing-to-land":
        return m.integrated_epics_heading_none();
      case "ready":
      case "confirming":
        return m.integrated_epics_short_ready({ number: number! });
      case "landed":
        return m.integrated_epics_path_landed();
      case "error":
        return m.integrated_epics_landing_failed();
      case "not-ready":
        return m.integrated_epics_heading_not_ready();
    }
  });
</script>

<div
  class="row"
  class:ready={status.tone === "ready"}
  class:warn={status.tone === "warn"}
  role="region"
  aria-label={epic.parentTitle}
>
  <button
    type="button"
    class="row-head"
    aria-expanded={open}
    aria-label={open
      ? m.integrated_epics_collapse_aria({ number: epic.parentIssueNumber })
      : m.integrated_epics_expand_aria({ number: epic.parentIssueNumber })}
    onclick={() => (open = !open)}
  >
    <span class="identity"
      ><span class="chev" class:collapsed={!open} aria-hidden="true">▾</span><span class="num"
        >{m.integrated_epics_identity({ number: epic.parentIssueNumber })}</span
      ><span class="repo" title={repoName}>{repoName}</span><span class="ago"
        >{m.integrated_epics_finished_ago({ ago: formatAgo(nowMs - epic.completedAt) })}</span
      ></span
    >
    <span class="epic-title" class:expanded={open}>{epic.parentTitle}</span>
  </button>
  <div class="chips">
    <span class="turn-chip">{turnLabel}</span>
    {#if epic.landingStranded}<span class="waiting-chip"
        >{m.integrated_epics_land_stranded({ ago: formatAgo(nowMs - epic.completedAt) })}</span
      >{/if}
    {#if epic.landingConflictStranded && epic.landingConflictSince != null}<span
        class="waiting-chip"
        >{m.integrated_epics_land_conflict_stranded({
          ago: formatAgo(nowMs - epic.landingConflictSince),
        })}</span
      >{/if}
    {#if !open}<span class="summary">{summary}</span>{/if}
  </div>
  {#if open}
    <IntegratedEpicLanding {epic} {onland} {ondismiss} {onackmigrations} {onresolveconflicts}>
      <section class="children-section">
        <button
          class="children-toggle"
          type="button"
          aria-expanded={childrenOpen}
          onclick={() => (childrenOpen = !childrenOpen)}
          ><span aria-hidden="true">{childrenOpen ? "▾" : "▸"}</span>
          {m.integrated_epics_children_heading({ included, total })}</button
        >
        {#if childrenOpen}
          <ul class="children">
            {#each epic.children as c (c.number)}
              <li class="child">
                <div class="child-line">
                  <span class="child-marker" class:excluded={!c.integrated} aria-hidden="true"
                    >{c.integrated ? "✓" : "–"}</span
                  >
                  {#if c.integrated && c.prUrl}
                    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
                    <a class="ref" href={c.prUrl} target="_blank" rel="noopener noreferrer"
                      >{c.prNumber != null
                        ? m.integrated_epics_pr_ref({ number: c.prNumber })
                        : m.integrated_epics_pr_ref_nonum()}</a
                    >
                  {:else if c.integrated && c.prNumber != null}<span class="ref"
                      >{m.integrated_epics_pr_ref({ number: c.prNumber })}</span
                    >
                  {:else}
                    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
                    <a class="ref" href={c.url} target="_blank" rel="noopener noreferrer"
                      >#{c.number}</a
                    >
                  {/if}
                  {#if c.integrated}<span class="child-ago"
                      >{m.integrated_epics_child_merged_ago({
                        ago: formatAgo(nowMs - (c.mergedAt ?? epic.completedAt)),
                      })}</span
                    >
                  {:else}<span class="excluded">{m.integrated_epics_child_closed()}</span>{/if}
                </div>
                {#if c.title !== `#${c.number}`}<div class="child-title">{c.title}</div>{/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    </IntegratedEpicLanding>
  {/if}
</div>

<style>
  .row {
    --epic-tone: var(--status-done);
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
    padding: 10px;
    border: 1px solid var(--color-line);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
  }
  .row.ready {
    --epic-tone: var(--color-green);
  }
  .row.warn {
    --epic-tone: var(--status-warn);
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
  .children-toggle:focus-visible {
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
  .chips {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
  }
  .turn-chip,
  .waiting-chip {
    padding: 3px 6px;
    border-radius: var(--radius-chip);
    border: 1px solid var(--epic-tone);
    background: color-mix(in srgb, var(--epic-tone) 12%, transparent);
    color: var(--color-ink);
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
  }
  .waiting-chip {
    border-color: var(--status-warn);
    color: var(--status-warn);
    background: transparent;
  }
  .summary {
    font-size: var(--fs-micro);
    color: var(--color-muted);
    overflow-wrap: anywhere;
  }
  .children-toggle {
    display: inline-flex;
    gap: 5px;
    padding: 2px 0;
    border: 0;
    background: none;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-micro);
    text-align: left;
    cursor: pointer;
  }
  .children {
    display: flex;
    flex-direction: column;
    gap: 8px;
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
  }
  .child-line {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
    font-size: var(--fs-micro);
  }
  .child-marker {
    color: var(--status-done);
  }
  .ref {
    color: var(--color-ink);
    text-decoration: none;
  }
  a.ref:hover {
    color: var(--color-ink-bright);
    text-decoration: underline;
  }
  .child-ago {
    color: var(--color-muted);
  }
  .excluded {
    color: var(--color-amber);
  }
  .child-title {
    margin: 3px 0 0 15px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--color-muted);
  }
  @media (pointer: coarse) {
    .row-head,
    .children-toggle {
      min-height: 44px;
    }
  }
</style>
