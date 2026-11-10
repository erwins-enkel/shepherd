<script lang="ts">
  import { onMount } from "svelte";
  import type { CompletedEpic } from "#lib/types.js";
  import { getEpicHistory } from "#lib/api.js";
  import { m } from "#lib/paraglide/messages.js";
  import EpicOutcomeRow from "../EpicOutcomeRow.svelte";

  // #3838: Done → Epics — every finished epic with its completion and confirmation time and its
  // issues/PRs, confirmed or not. Read on open; a confirmation made here re-reads the list.
  let {
    repoFilter,
    nowMs,
    onacknowledge,
    onackmigrations,
  }: {
    repoFilter: ReadonlySet<string>;
    nowMs: number;
    onacknowledge?: (repoPath: string, parent: number) => Promise<boolean>;
    onackmigrations?: (repoPath: string, parent: number) => void | Promise<void>;
  } = $props();

  let rows = $state<CompletedEpic[] | null>(null);
  let failed = $state(false);
  const shown = $derived(
    (rows ?? []).filter((e) => repoFilter.size === 0 || repoFilter.has(e.repoPath)),
  );

  async function load() {
    failed = false;
    try {
      rows = await getEpicHistory();
    } catch {
      failed = true;
    }
  }
  onMount(() => void load());

  async function acknowledge(repoPath: string, parent: number): Promise<boolean> {
    const ok = (await onacknowledge?.(repoPath, parent)) ?? false;
    if (ok) await load();
    return ok;
  }
  async function ackMigrations(repoPath: string, parent: number): Promise<void> {
    await onackmigrations?.(repoPath, parent);
    await load();
  }
</script>

<div class="history">
  {#if failed}
    <p class="empty" role="alert">
      {m.epic_history_failed()}
      <button type="button" class="retry" onclick={() => void load()}>{m.common_retry()}</button>
    </p>
  {:else if rows === null}
    <p class="empty">{m.common_loading()}</p>
  {:else if shown.length === 0}
    <p class="empty">{m.epic_history_empty()}</p>
  {:else}
    {#each shown as epic (`${epic.repoPath}#${epic.parentIssueNumber}`)}
      <EpicOutcomeRow
        {epic}
        {nowMs}
        history
        onacknowledge={onacknowledge ? acknowledge : undefined}
        onackmigrations={onackmigrations ? ackMigrations : undefined}
      />
    {/each}
  {/if}
</div>

<style>
  .history {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-block: 8px;
    min-width: 0;
  }
  .empty {
    margin: 0;
    padding: 12px 4px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .retry {
    padding: 0;
    border: 0;
    background: none;
    color: var(--color-ink);
    font: inherit;
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
  }
  .retry:focus-visible {
    outline: 2px solid var(--color-ink-bright);
    outline-offset: 2px;
  }
</style>
