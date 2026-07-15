<script lang="ts">
  import { untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { listPullRequests } from "$lib/api";
  import type { PullRequest } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { prsFilter } from "$lib/prs-filter.svelte";
  import {
    hideDraftPrs,
    hideConflictPrs,
    hideFailingCiPrs,
    filterByAuthor,
    distinctAuthors,
  } from "./prs-panel";
  import PrRow from "./PrRow.svelte";
  import PrFilterPopover from "./PrFilterPopover.svelte";
  import RepoLink from "./RepoLink.svelte";

  let {
    repoPath,
    onreview,
    onlaunchtrain,
    inTrainPrs = new Set(),
    age = false,
  }: {
    repoPath: string;
    /** Open a review task seeded with this PR (mirrors the issue → task path). */
    onreview: (pr: PullRequest) => void;
    /** Launch a merge train from the multi-selected PRs (in display order).
     *  Optional so existing consumers keep compiling until Task 3 wires it. */
    onlaunchtrain?: (repoPath: string, prs: PullRequest[]) => void;
    /** PR identity keys (`${repoPath}#${number}`) owned by a running merge train;
     *  a matching row shows the in-train badge and locks its manual merge button. */
    inTrainPrs?: Set<string>;
    age?: boolean;
  } = $props();

  let prs = $state<PullRequest[]>([]);
  let slug = $state<string | null>(null);
  let repoUrl = $state<string | null>(null);
  let loading = $state(true);

  // Repo-scoped author filter. Selection is local (not the global prsFilter store)
  // because the option set is repo-specific; reset on repo change and pruned on refresh
  // (see the effects below). Options are derived from the RAW `prs` list so picking one
  // author doesn't drop the others from the picker.
  let selectedAuthor = $state<string | null>(null);
  const availableAuthors = $derived(distinctAuthors(prs));

  // The three global toggle filters (drafts / conflicts / failed CI) → the repo-scoped
  // author filter. Pure derive over the loaded list — no API round-trip. Everything the
  // panel renders and acts on (rows, select-all, launch train, empty state) keys off this,
  // so a hidden PR can never be armed into a merge train.
  const visiblePrs = $derived(
    filterByAuthor(
      hideFailingCiPrs(
        hideConflictPrs(hideDraftPrs(prs, prsFilter.hideDrafts), prsFilter.hideConflicts),
        prsFilter.hideFailingCi,
      ),
      selectedAuthor,
    ),
  );

  // Multi-select for launching a merge train. Holds PR numbers; the launch payload is
  // always reconciled against the VISIBLE list so a row that merged out — or that a filter
  // now hides — can't keep a phantom number armed.
  let selected = new SvelteSet<number>();
  const presentSelected = $derived(visiblePrs.filter((p) => selected.has(p.number)));
  const allSelected = $derived(
    visiblePrs.length > 0 && presentSelected.length === visiblePrs.length,
  );

  function toggle(n: number) {
    if (selected.has(n)) selected.delete(n);
    else selected.add(n);
  }
  function toggleAll() {
    if (allSelected) selected.clear();
    else for (const p of visiblePrs) selected.add(p.number);
  }

  // `silent` reloads without flipping the full-panel loading placeholder — used
  // after a merge so the optimistic row removal stays visible while we reconcile.
  function load(rp: string, silent = false) {
    if (!silent) loading = true;
    listPullRequests(rp)
      .then((r) => {
        if (rp !== repoPath) return;
        slug = r.slug;
        repoUrl = r.webUrl;
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
      // Selection + author filter must never leak across repos — reset whenever the repo flips.
      selected.clear();
      selectedAuthor = null;
      load(rp);
    });
  });

  // Prune a selected author that a refresh removed from the current PR set — otherwise an
  // absent-but-selected author keeps filtering while its picker entry is gone (the popover
  // only lists present authors), stranding the list unclearable. Keyed on the derived option
  // set (which depends on `prs`, not on the selection), so it can't loop; write is untracked.
  $effect(() => {
    const authors = availableAuthors;
    untrack(() => {
      if (selectedAuthor != null && !authors.includes(selectedAuthor)) selectedAuthor = null;
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
    {m.prspanel_title()}<RepoLink {slug} webUrl={repoUrl} />
  </div>

  {#if prs.length > 0}
    <div class="prs-toolbar">
      <PrFilterPopover
        authors={availableAuthors}
        {selectedAuthor}
        onauthor={(a) => (selectedAuthor = a)}
      />
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
    {:else if visiblePrs.length === 0}
      <div class="muted">{m.prspanel_none_match()}</div>
    {:else}
      {#each visiblePrs as pr (pr.number)}
        <PrRow
          {repoPath}
          {pr}
          {age}
          {onreview}
          {onmerged}
          inTrain={inTrainPrs.has(`${repoPath}#${pr.number}`)}
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
