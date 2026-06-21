<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import type { UsageBreakdown, UsageRepoBreakdown, UsageTaskBreakdown } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import GlossaryText from "$lib/components/GlossaryText.svelte";
  import UsageBar from "./UsageBar.svelte";
  import { formatUnits, formatPct, formatDollars } from "./format";

  const { breakdown }: { breakdown: UsageBreakdown } = $props();

  /** Total weighted units for a repo. */
  function repoTotal(repo: UsageRepoBreakdown): number {
    return repo.authoringUnits + repo.satelliteUnits;
  }

  /** Total weighted units for a task. */
  function taskTotal(task: UsageTaskBreakdown): number {
    return task.authoringUnits + task.satelliteUnits;
  }

  /** Repos sorted descending by total units. */
  const sortedRepos = $derived([...breakdown.repos].sort((a, b) => repoTotal(b) - repoTotal(a)));

  /** Maximum repo total — used as the scale reference for all repo bars. */
  const maxRepoTotal = $derived(sortedRepos.length > 0 ? repoTotal(sortedRepos[0]) : 1);

  /**
   * Expanded repos tracked by repoPath.
   * Default: largest repo (first after sort) starts expanded.
   * We compute the initial default directly from props (not from $derived) to
   * avoid the state_referenced_locally Svelte 5 lint error.
   */
  function initialExpanded(): SvelteSet<string> {
    const set = new SvelteSet<string>();
    if (breakdown.repos.length === 0) return set;
    const largest = [...breakdown.repos].sort((a, b) => repoTotal(b) - repoTotal(a))[0];
    set.add(largest.repoPath);
    return set;
  }

  const expandedPaths = initialExpanded();

  function toggleRepo(path: string) {
    if (expandedPaths.has(path)) {
      expandedPaths.delete(path);
    } else {
      expandedPaths.add(path);
    }
  }

  /** Top 3 tasks for a repo, sorted descending. */
  function topTasks(repo: UsageRepoBreakdown): UsageTaskBreakdown[] {
    return [...repo.tasks].sort((a, b) => taskTotal(b) - taskTotal(a)).slice(0, 3);
  }

  /** Remaining task count beyond the top 3. */
  function remainingTaskCount(repo: UsageRepoBreakdown): number {
    return Math.max(0, repo.tasks.length - 3);
  }

  /** Max task total within a repo (for bar scaling). */
  function maxTaskTotal(repo: UsageRepoBreakdown): number {
    if (repo.tasks.length === 0) return 1;
    return Math.max(...repo.tasks.map(taskTotal));
  }
</script>

<div class="spend-lens">
  <div class="spend-header">
    <h2 class="spend-heading">{m.usage_spend_heading()}</h2>
    <span class="units-label">
      <GlossaryText text={m.usage_units_label()} />
    </span>
    {#if breakdown.dollars != null}
      <span class="spend-total-cost" aria-label={m.usage_spend_cost_label()}>
        {formatDollars(breakdown.dollars)}
      </span>
    {/if}
  </div>

  <div class="repo-list">
    {#each sortedRepos as repo (repo.repoPath)}
      {@const total = repoTotal(repo)}
      {@const expanded = expandedPaths.has(repo.repoPath)}
      {@const tasks = topTasks(repo)}
      {@const remaining = remainingTaskCount(repo)}
      {@const maxTask = maxTaskTotal(repo)}

      <div class="repo-row-wrap">
        <button
          class="repo-row"
          class:has-cost={breakdown.dollars != null}
          aria-expanded={expanded}
          onclick={() => toggleRepo(repo.repoPath)}
          type="button"
        >
          <span class="caret" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          <span class="repo-name">{repo.repoName}</span>
          <span class="repo-bar">
            <UsageBar value={total} max={maxRepoTotal} />
          </span>
          <span class="repo-pct">{formatPct(total / breakdown.totalUnits)}</span>
          <span class="repo-units">{formatUnits(total)}</span>
          {#if breakdown.dollars != null}
            <span class="repo-cost">{formatDollars(repo.dollars ?? 0)}</span>
          {/if}
        </button>

        {#if expanded}
          <div class="task-list">
            {#each tasks as task (task.sessionId)}
              {@const tTotal = taskTotal(task)}
              <div class="task-row">
                <span class="task-desig">{task.desig}</span>
                <span class="task-bar">
                  <UsageBar value={tTotal} max={maxTask} tone="var(--color-slate)" />
                </span>
                <span class="task-units">{formatUnits(tTotal)}</span>
              </div>
            {/each}
            {#if remaining > 0}
              <div class="task-more">
                {m.usage_more_count({ count: remaining })}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .spend-lens {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .spend-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .spend-heading {
    font-size: var(--fs-lg);
    font-weight: 600;
    color: var(--color-ink-bright);
    margin: 0;
  }

  .units-label {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    text-align: right;
  }

  .repo-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .repo-row-wrap {
    display: flex;
    flex-direction: column;
  }

  .repo-row {
    display: grid;
    grid-template-columns: 1rem 8rem 1fr 3rem 5rem;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.5rem;
    background: none;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
    color: var(--color-ink);
    font-size: var(--fs-base);
    transition: background 0.1s;
    width: 100%;
  }

  .repo-row.has-cost {
    grid-template-columns: 1rem 8rem 1fr 3rem 5rem 4rem;
  }

  .repo-row:hover {
    background: var(--color-hover);
  }

  .caret {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    user-select: none;
  }

  .repo-name {
    font-weight: 500;
    color: var(--color-ink-bright);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .repo-bar {
    display: flex;
    align-items: center;
  }

  .repo-pct {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    text-align: right;
  }

  .repo-units {
    font-size: var(--fs-base);
    color: var(--color-ink);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .repo-cost {
    font-size: var(--fs-base);
    color: var(--color-ink);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .spend-total-cost {
    font-size: var(--fs-meta);
    color: var(--color-ink);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .task-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 0 0 0.25rem 1.5rem;
  }

  .task-row {
    display: grid;
    grid-template-columns: 6rem 1fr 5rem;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem;
    font-size: var(--fs-meta);
  }

  .task-desig {
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .task-bar {
    display: flex;
    align-items: center;
  }

  .task-units {
    color: var(--color-ink);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .task-more {
    font-size: var(--fs-micro);
    color: var(--color-faint);
    padding: 0.2rem 0.5rem;
    font-style: italic;
  }
</style>
