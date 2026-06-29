<script lang="ts">
  import type { UpNextItem, UpNextSection } from "$lib/types";
  import { upNext } from "$lib/up-next.svelte";
  import { refreshUpNext, startUpNext } from "$lib/api";
  import { toasts } from "$lib/toasts.svelte";
  import { formatAgo } from "$lib/format";
  import { clock } from "$lib/now.svelte";
  import { m } from "$lib/paraglide/messages";
  import { SvelteSet } from "svelte/reactivity";
  import { onMount } from "svelte";

  // Open the Backlog overlay from the empty state (threaded up through Herd to +page).
  // repoFilter: full repoPath of the active chip-rail filter (null = unfiltered) — scopes the
  // queue to one repo, identical to how the session lenses filter.
  let { onbacklog, repoFilter = null }: { onbacklog?: () => void; repoFilter?: string | null } =
    $props();

  // On lens-open: repaint the cached snapshot and kick a server recompute (GET /api/up-next
  // triggers a background refresh that lands in place via the upnext:snapshot WS event), so the
  // lens reflects "now" rather than the last app-load — not just on-app-load (#1169 spec).
  onMount(() => {
    void upNext.load();
  });

  // Display caps mirror src/up-next-core PRIORITY_CAP / REPO_CAP; the server returns the full
  // ranked list and we reveal the rest in place via "show all N".
  const PRIORITY_CAP = 10;
  const REPO_CAP = 5;
  // Manual starts bypass the per-repo maxAuto drain cap, so a large batch could launch a swarm
  // unintentionally — confirm above this many selected (issue #1169 tunable).
  const CONFIRM_THRESHOLD = 3;

  const snap = $derived(upNext.snapshot);
  // The chip-rail repo filter scopes the queue to one repo, identical to the session lenses.
  // Repo sections drop unless they match; the cross-repo priority section keeps only its items
  // from the active repo (re-counting totalCount so "show all N" stays honest).
  const sections = $derived.by(() => {
    const all = snap?.sections ?? [];
    if (!repoFilter) return all;
    return all
      .map((s): UpNextSection | null => {
        if (s.kind === "repo") return s.repoPath === repoFilter ? s : null;
        const items = s.items.filter((it) => it.repoPath === repoFilter);
        return items.length > 0 ? { ...s, items, totalCount: items.length } : null;
      })
      .filter((s): s is UpNextSection => s !== null);
  });
  // Empty ("all caught up") only once the server has actually produced a snapshot; a null/
  // never-computed snapshot shows loading, not the all-clear.
  const computed = $derived(snap?.generatedAt != null);
  const isEmpty = $derived(computed && sections.length === 0);
  const updatedAgo = $derived(
    snap?.generatedAt != null ? formatAgo(clock.current - snap.generatedAt) : null,
  );

  // Selection keyed by repoPath#number (issue numbers repeat across repos).
  const keyOf = (it: UpNextItem) => `${it.repoPath}#${it.number}`;
  const selected = new SvelteSet<string>();
  const expanded = new SvelteSet<string>();
  let starting = $state(false);
  let confirmPending = $state(false);

  const sectionKey = (s: UpNextSection) =>
    s.kind === "priority" ? "priority" : (s.repoPath ?? "");
  const capOf = (s: UpNextSection) => (s.kind === "priority" ? PRIORITY_CAP : REPO_CAP);
  function shownItems(s: UpNextSection): UpNextItem[] {
    return expanded.has(sectionKey(s)) ? s.items : s.items.slice(0, capOf(s));
  }

  // Selected items still present in the current snapshot (a refresh may have dropped some).
  const selectedItems = $derived(
    sections.flatMap((s) => s.items).filter((it) => selected.has(keyOf(it))),
  );
  const selectedCount = $derived(selectedItems.length);

  function toggle(it: UpNextItem) {
    const k = keyOf(it);
    if (selected.has(k)) selected.delete(k);
    else selected.add(k);
    confirmPending = false; // selection changed — re-confirm if still over threshold
  }
  function toggleExpand(s: UpNextSection) {
    const k = sectionKey(s);
    if (expanded.has(k)) expanded.delete(k);
    else expanded.add(k);
  }

  async function doStart(items: UpNextItem[]) {
    if (starting || items.length === 0) return;
    starting = true;
    confirmPending = false;
    try {
      const res = await startUpNext(
        items.map((it) => ({ repoPath: it.repoPath, issueRef: it.issueRef })),
      );
      if (res.created.length > 0) {
        toasts.info(m.upnext_started({ count: res.created.length }), { key: "upnext-started" });
      }
      if (res.errors.length > 0) {
        // Failure must stay until acknowledged — persistent + tone-namespaced dedupe key.
        toasts.info(m.upnext_start_failed({ count: res.errors.length }), {
          key: "upnext-start-failed",
          alert: true,
          duration: null,
        });
      }
      // Clear only the ones we just started; the WS snapshot refresh removes them shortly.
      for (const it of items) selected.delete(keyOf(it));
    } catch {
      toasts.info(m.upnext_start_failed({ count: items.length }), {
        key: "upnext-start-failed",
        alert: true,
        duration: null,
      });
    } finally {
      starting = false;
    }
  }

  function startSelected() {
    if (selectedCount > CONFIRM_THRESHOLD && !confirmPending) {
      confirmPending = true;
      return;
    }
    void doStart(selectedItems);
  }

  let refreshing = $state(false);
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      await refreshUpNext();
    } catch {
      /* the background loop / WS will still update */
    } finally {
      refreshing = false;
    }
  }

  const repoBase = (p: string | null) => p?.split("/").filter(Boolean).at(-1) ?? "";
  function sectionTitle(s: UpNextSection): string {
    return s.kind === "priority"
      ? m.upnext_priority_section()
      : (s.repoLabel ?? repoBase(s.repoPath));
  }
</script>

{#snippet pill(label: string, cls: string)}
  <span class="un-pill {cls}">{label}</span>
{/snippet}

{#snippet row(it: UpNextItem)}
  <li class="un-row">
    <label class="un-check">
      <input
        type="checkbox"
        checked={selected.has(keyOf(it))}
        onchange={() => toggle(it)}
        aria-label={m.upnext_select_aria({ number: it.number, title: it.title })}
      />
    </label>
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL, not an app route -->
    <a class="un-link" href={it.url} target="_blank" rel="noopener noreferrer">
      <span class="un-num">#{it.number}</span>
      <span class="un-title">{it.title}</span>
    </a>
    <span class="un-pills">
      {#if it.priority}{@render pill(m.upnext_pill_priority(), "un-pill-priority")}{/if}
      {#if it.kind === "epic"}{@render pill(m.upnext_pill_epic(), "un-pill-epic")}{/if}
      {#if it.kind === "bug"}{@render pill(m.upnext_pill_bug(), "un-pill-bug")}{/if}
    </span>
    <span class="un-age">{formatAgo(clock.current - it.createdAt)}</span>
    <button
      type="button"
      class="un-start"
      disabled={starting}
      onclick={() => doStart([it])}
      title={m.upnext_start()}>{m.upnext_start()}</button
    >
  </li>
{/snippet}

<section class="upnext" aria-label={m.upnext_title()}>
  <header class="un-head">
    <span class="un-title-h">{m.upnext_title()}</span>
    {#if updatedAgo}
      <span class="un-updated">{m.upnext_updated_ago({ ago: updatedAgo })}</span>
    {/if}
    <button
      type="button"
      class="un-refresh"
      disabled={refreshing}
      aria-busy={refreshing}
      title={m.upnext_refresh()}
      aria-label={m.upnext_refresh()}
      onclick={refresh}>⟳</button
    >
  </header>

  {#if selectedCount > 0}
    <div class="un-batch" role="region" aria-label={m.upnext_batch_aria()}>
      {#if confirmPending}
        <span class="un-confirm-text">{m.upnext_confirm({ count: selectedCount })}</span>
        <button
          type="button"
          class="un-batch-go un-confirm"
          disabled={starting}
          onclick={startSelected}>{m.upnext_confirm_yes()}</button
        >
        <button type="button" class="un-batch-cancel" onclick={() => (confirmPending = false)}
          >{m.common_cancel()}</button
        >
      {:else}
        <button type="button" class="un-batch-go" disabled={starting} onclick={startSelected}
          >{m.upnext_start_selected({ count: selectedCount })}</button
        >
        <button type="button" class="un-batch-cancel" onclick={() => selected.clear()}
          >{m.upnext_clear_selection()}</button
        >
      {/if}
    </div>
  {/if}

  <div class="un-body">
    {#if !computed}
      <!-- No server snapshot yet (first compute in flight) → loading, never the all-clear. -->
      <p class="un-muted">{m.common_loading()}</p>
    {:else if isEmpty}
      <div class="un-empty">
        <p class="un-muted">
          {repoFilter
            ? m.upnext_repo_filter_empty({ repo: repoBase(repoFilter) })
            : m.upnext_empty()}
        </p>
        {#if onbacklog}
          <button type="button" class="un-backlog-link" onclick={() => onbacklog?.()}
            >{m.upnext_open_backlog()}</button
          >
        {/if}
      </div>
    {:else}
      {#each sections as s (sectionKey(s))}
        <div class="un-section">
          <p class="un-section-head" class:un-section-head-priority={s.kind === "priority"}>
            {sectionTitle(s)}
          </p>
          <ul class="un-list">
            {#each shownItems(s) as it (keyOf(it))}
              {@render row(it)}
            {/each}
          </ul>
          {#if s.totalCount > capOf(s)}
            <button type="button" class="un-expand" onclick={() => toggleExpand(s)}>
              {expanded.has(sectionKey(s))
                ? m.upnext_show_less()
                : m.upnext_show_all({ count: s.totalCount })}
            </button>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</section>

<style>
  .upnext {
    position: relative;
    border: 1px solid var(--color-line);
    background: var(--color-panel);
    display: flex;
    flex-direction: column;
    overflow: auto;
    min-height: 0;
    flex: 1;
  }

  .un-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-line);
  }
  .un-title-h {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-ink-bright);
    font-weight: 600;
  }
  .un-updated {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .un-refresh {
    margin-left: auto;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-lg);
    line-height: 1;
    padding: 2px 7px;
    cursor: pointer;
    transition: color 0.12s ease;
  }
  .un-refresh:hover:not(:disabled) {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .un-refresh:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .un-refresh:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .un-batch {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--color-line);
    background: var(--color-inset);
    flex-wrap: wrap;
  }
  .un-confirm-text {
    font-size: var(--fs-meta);
    color: var(--color-amber);
  }
  .un-batch-go {
    background: transparent;
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    color: var(--color-amber);
    font: inherit;
    font-size: var(--fs-meta);
    padding: 4px 11px;
    cursor: pointer;
    transition:
      color 0.12s ease,
      background 0.12s ease;
  }
  .un-batch-go:hover:not(:disabled) {
    background: var(--color-amber);
    color: var(--color-bg);
  }
  .un-batch-go:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .un-batch-cancel {
    background: none;
    border: 0;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
  }
  .un-batch-cancel:hover {
    color: var(--color-ink);
  }

  .un-body {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 14px 16px;
  }
  .un-section {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .un-section-head {
    margin: 0;
    font-size: var(--fs-micro);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-muted);
  }
  /* Priority is the cross-repo headline tier — amber, the "needs you / actionable" hue. */
  .un-section-head-priority {
    color: var(--color-amber);
  }

  .un-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .un-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
  }
  .un-check {
    display: flex;
    align-items: center;
  }
  .un-check input {
    cursor: pointer;
  }
  .un-link {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    flex: 1;
    text-decoration: none;
    color: var(--color-ink);
  }
  .un-link:hover .un-title {
    color: var(--color-amber);
  }
  .un-num {
    font-size: var(--fs-micro);
    color: var(--color-muted);
    flex: none;
  }
  .un-title {
    font-size: var(--fs-meta);
    color: var(--color-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: color 0.12s ease;
  }
  .un-pills {
    display: flex;
    gap: 4px;
    flex: none;
  }
  .un-pill {
    font-size: var(--fs-micro);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    padding: 0 4px;
    color: var(--color-muted);
  }
  .un-pill-priority {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .un-pill-bug {
    color: var(--color-red);
    border-color: var(--color-red);
  }
  .un-pill-epic {
    color: var(--color-ink-bright);
    border-color: var(--color-line-bright);
  }
  .un-age {
    font-size: var(--fs-micro);
    color: var(--color-faint);
    flex: none;
  }
  .un-start {
    flex: none;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-micro);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 2px 8px;
    cursor: pointer;
    transition:
      color 0.12s ease,
      border-color 0.12s ease;
  }
  .un-start:hover:not(:disabled) {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .un-start:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .un-start:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .un-expand {
    align-self: flex-start;
    background: none;
    border: 0;
    padding: 2px 0 0;
    font: inherit;
    font-size: var(--fs-micro);
    color: var(--color-muted);
    cursor: pointer;
  }
  .un-expand:hover {
    color: var(--color-amber);
  }

  .un-muted {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .un-empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .un-backlog-link {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    font-size: var(--fs-meta);
    color: var(--color-amber);
    cursor: pointer;
    text-decoration: underline;
  }
  .un-backlog-link:hover {
    color: var(--color-amber);
    text-decoration: none;
  }
  .un-backlog-link:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
</style>
