<script lang="ts">
  import { listPullRequests } from "$lib/api";
  import type { PullRequest } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import PrRow from "./PrRow.svelte";

  let {
    repoPath,
    onreview,
    age = false,
  }: {
    repoPath: string;
    /** Open a review task seeded with this PR (mirrors the issue → task path). */
    onreview: (pr: PullRequest) => void;
    age?: boolean;
  } = $props();

  let prs = $state<PullRequest[]>([]);
  let slug = $state<string | null>(null);
  let loading = $state(true);

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
    load(repoPath);
  });

  // Drop the merged row immediately; a silent reload reconciles the rest
  // (e.g. a stacked PR that just became mergeable) without flashing the list.
  function onmerged(number: number) {
    prs = prs.filter((p) => p.number !== number);
    load(repoPath, true);
  }
</script>

<div class="prs-panel">
  <div class="prs-header">
    {#if slug}{m.prspanel_title_with_slug({ slug })}{:else}{m.prspanel_title()}{/if}
  </div>

  <div class="prs-list">
    {#if loading}
      <div class="muted">{m.common_loading()}</div>
    {:else if slug === null}
      <div class="muted">{m.issuespanel_no_host()}</div>
    {:else if prs.length === 0}
      <div class="muted">{m.prspanel_no_open()}</div>
    {:else}
      {#each prs as pr (pr.number)}
        <PrRow {repoPath} {pr} {age} {onreview} {onmerged} />
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
