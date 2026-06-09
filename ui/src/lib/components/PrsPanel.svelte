<script lang="ts">
  import { untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { listPullRequests } from "$lib/api";
  import type { PullRequest } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import PrRow from "./PrRow.svelte";

  let {
    repoPath,
    onreview,
    onlaunchtrain,
    age = false,
  }: {
    repoPath: string;
    /** Open a review task seeded with this PR (mirrors the issue → task path). */
    onreview: (pr: PullRequest) => void;
    /** Launch a merge train from the multi-selected PRs (in display order).
     *  Optional so existing consumers keep compiling until Task 3 wires it. */
    onlaunchtrain?: (repoPath: string, prs: PullRequest[]) => void;
    age?: boolean;
  } = $props();

  let prs = $state<PullRequest[]>([]);
  let slug = $state<string | null>(null);
  let loading = $state(true);

  // Multi-select for launching a merge train. Holds PR numbers; the launch
  // payload is always reconciled against the present list so a row that merged
  // out from under the set can't keep a phantom number armed.
  let selected = new SvelteSet<number>();
  const presentSelected = $derived(prs.filter((p) => selected.has(p.number)));
  const allSelected = $derived(prs.length > 0 && presentSelected.length === prs.length);

  function toggle(n: number) {
    if (selected.has(n)) selected.delete(n);
    else selected.add(n);
  }
  function toggleAll() {
    if (allSelected) selected.clear();
    else for (const p of prs) selected.add(p.number);
  }

  // `silent` reloads without flipping the full-panel loading placeholder — used
  // after a merge so the optimistic row removal stays visible while we reconcile.
  function load(rp: string, silent = false) {
    if (!silent) loading = true;
    listPullRequests(rp)
      .then((r) => {
        if (rp !== repoPath) return;
        slug = r.slug;
        prs = r.prs;
        loading = false;
      })
      .catch(() => {
        if (rp !== repoPath) return; // a stale failure must not clear the current repo's spinner
        loading = false;
      });
  }

  $effect(() => {
    // Re-run ONLY when the repo flips. `selected.clear()` reads the set's version
    // internally, so running it (un-untracked) would make this effect a dependent
    // of `selected` and a plain row-toggle would wrongly wipe the selection.
    const rp = repoPath;
    untrack(() => {
      // Selection must never leak across repos — clear it whenever the repo flips.
      selected.clear();
      load(rp);
    });
  });

  // Drop the merged row immediately; a silent reload reconciles the rest
  // (e.g. a stacked PR that just became mergeable) without flashing the list.
  function onmerged(number: number) {
    prs = prs.filter((p) => p.number !== number);
    selected.delete(number); // keep the set from accumulating a now-gone number
    load(repoPath, true);
  }
</script>

<div class="prs-panel">
  <div class="prs-header">
    {#if slug}{m.prspanel_title_with_slug({ slug })}{:else}{m.prspanel_title()}{/if}
  </div>

  {#if prs.length > 0}
    <div class="prs-toolbar">
      <button type="button" class="link" onclick={toggleAll}>
        {allSelected ? m.prspanel_clear_all() : m.prspanel_select_all()}
      </button>
      <span class="count">{m.prspanel_selected_count({ count: presentSelected.length })}</span>
      <button
        type="button"
        class="gbtn"
        disabled={presentSelected.length < 2}
        onclick={() => onlaunchtrain?.(repoPath, presentSelected)}
      >
        {m.prspanel_launch_train()}
      </button>
    </div>
  {/if}

  <div class="prs-list">
    {#if loading}
      <div class="muted">{m.common_loading()}</div>
    {:else if slug === null}
      <div class="muted">{m.issuespanel_no_host()}</div>
    {:else if prs.length === 0}
      <div class="muted">{m.prspanel_no_open()}</div>
    {:else}
      {#each prs as pr (pr.number)}
        <PrRow
          {repoPath}
          {pr}
          {age}
          {onreview}
          {onmerged}
          selectable
          selected={selected.has(pr.number)}
          ontoggle={() => toggle(pr.number)}
        />
      {/each}
    {/if}
  </div>
</div>

<style>
  .prs-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-inset);
    font-family: var(--font-mono);
    overflow: hidden;
  }

  .prs-header {
    padding: 6px 12px;
    font-size: var(--fs-micro);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
  }

  /* Pinned launch toolbar: a sibling of the scroller (never a row inside it) so
     it stays reachable with a long PR list — matches the header's chrome. */
  .prs-toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
  }

  .prs-toolbar .link {
    background: transparent;
    border: 0;
    color: var(--color-amber);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
  }

  .prs-toolbar .count {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin-right: auto;
    font-variant-numeric: tabular-nums;
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
    transition:
      border-color 0.12s,
      color 0.12s;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .prs-list {
    flex: 1;
    overflow-y: auto;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .prs-list::-webkit-scrollbar {
    width: 4px;
  }
  .prs-list::-webkit-scrollbar-track {
    background: transparent;
  }
  .prs-list::-webkit-scrollbar-thumb {
    background: var(--color-faint);
    border-radius: 2px;
  }

  .muted {
    font-size: var(--fs-base);
    color: var(--color-faint);
    padding: 4px 0;
  }

  @media (max-width: 768px) {
    .prs-list {
      -webkit-overflow-scrolling: touch;
    }
  }
</style>
