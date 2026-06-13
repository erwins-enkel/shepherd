<script lang="ts">
  import type { CompletedEpic } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { formatAgo } from "$lib/format";

  let {
    epic,
    ondismiss,
    nowMs = Date.now(),
  }: {
    epic: CompletedEpic;
    ondismiss: (repoPath: string, parent: number) => void;
    nowMs?: number;
  } = $props();

  let open = $state(false);

  // repo basename — last path segment (e.g. "community-map")
  const repoName = $derived(epic.repoPath.split("/").filter(Boolean).at(-1) ?? epic.repoPath);

  // merged = count of shepherd-integrated children; total = all done children
  const total = $derived(epic.children.length);
  const merged = $derived(epic.children.filter((c) => c.integrated).length);

  // Parent issue URL derived from any child's issue URL: children are all issues in
  // the same repo (".../issues/<n>"), so swapping the trailing /<n> for the parent
  // number targets the parent issue. Null when no child carries a url → plain text.
  const parentUrl = $derived.by(() => {
    const ref = epic.children.find((c) => c.url)?.url;
    if (!ref) return null;
    return ref.replace(/\/\d+(?=\/?$)/, `/${epic.parentIssueNumber}`);
  });
</script>

<div class="row" role="region" aria-label={epic.parentTitle}>
  <button
    type="button"
    class="row-head"
    aria-expanded={open}
    aria-label={open
      ? m.integrated_epics_collapse_aria({ number: epic.parentIssueNumber })
      : m.integrated_epics_expand_aria({ number: epic.parentIssueNumber })}
    onclick={() => (open = !open)}
  >
    <span class="chev" class:collapsed={!open} aria-hidden="true">▾</span>
    <span class="repo" title={repoName}>{repoName}</span>
    <span class="title">{epic.parentTitle}</span>
    <span class="num">#{epic.parentIssueNumber}</span>
    <span class="chip chip-done">{m.integrated_epics_chip({ merged, total })}</span>
    <span class="ago"
      >{m.integrated_epics_finished_ago({ ago: formatAgo(nowMs - epic.completedAt) })}</span
    >
  </button>

  {#if open}
    <ul class="children">
      {#each epic.children as c (c.number)}
        <li class="child">
          {#if c.integrated && c.prUrl}
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
            <a class="ref" href={c.prUrl} target="_blank" rel="noopener noreferrer"
              >{c.prNumber != null
                ? m.integrated_epics_pr_ref({ number: c.prNumber })
                : m.integrated_epics_pr_ref_nonum()}</a
            >
            <span class="title">{c.title}</span>
            <span class="child-ago"
              >{m.integrated_epics_child_merged_ago({
                ago: formatAgo(nowMs - (c.mergedAt ?? epic.completedAt)),
              })}</span
            >
          {:else}
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
            <a class="ref" href={c.url} target="_blank" rel="noopener noreferrer">#{c.number}</a>
            <span class="title">{c.title}</span>
            <span class="closed">{m.integrated_epics_child_closed()}</span>
          {/if}
        </li>
      {/each}
    </ul>

    <div class="actions">
      <button
        class="gbtn"
        type="button"
        title={m.integrated_epics_dismiss()}
        onclick={() => ondismiss(epic.repoPath, epic.parentIssueNumber)}
      >
        {m.integrated_epics_dismiss()}
      </button>
      {#if parentUrl}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
        <a class="awaiting" href={parentUrl} target="_blank" rel="noopener noreferrer"
          >{m.integrated_epics_awaiting_landing({ number: epic.parentIssueNumber })}</a
        >
      {:else}
        <span class="awaiting"
          >{m.integrated_epics_awaiting_landing({ number: epic.parentIssueNumber })}</span
        >
      {/if}
    </div>
  {/if}
</div>

<style>
  .row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
  }

  /* Collapsed header — quiet/slate, matching the done-state recipe. */
  .row-head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    border: 0;
    background: none;
    font: inherit;
    color: var(--status-done);
    text-align: left;
    cursor: pointer;
    padding: 4px 8px;
  }
  .row-head:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  .chev {
    flex: none;
    transition: transform 0.12s ease;
  }
  .chev.collapsed {
    transform: rotate(-90deg);
  }

  .repo {
    flex: 0 1 auto;
    min-width: 0;
    color: var(--color-muted);
    max-width: 16ch;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .title {
    flex: 1;
    min-width: 0;
    color: var(--color-ink);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .num {
    flex: none;
    color: var(--color-muted);
  }

  .ago {
    flex: none;
    color: var(--color-faint);
    font-size: var(--fs-micro);
  }

  /* Slate "done" chip — NEVER green; mirrors EpicPanel's .chip-done recipe. */
  .chip {
    flex: none;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 1px 5px;
    border-radius: 2px;
    white-space: nowrap;
  }
  .chip-done {
    color: var(--status-done);
    background: color-mix(in oklab, var(--status-done) 12%, transparent);
  }

  /* Expanded rollup. */
  .children {
    margin: 0;
    padding: 0 8px;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .child {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .ref {
    flex: none;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    text-decoration: none;
  }
  .ref:hover {
    color: var(--color-ink-bright);
    text-decoration: underline;
  }
  .child-ago {
    flex: none;
    color: var(--color-faint);
    font-size: var(--fs-micro);
  }
  .closed {
    flex: none;
    color: var(--color-faint);
    font-size: var(--fs-micro);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

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
</style>
