<script lang="ts">
  import { onMount } from "svelte";
  import { getSettings, putSettings, listDirs } from "$lib/api";
  import type { DirListing } from "$lib/types";
  import SteersEditor from "$lib/components/SteersEditor.svelte";

  let { onclose, onsaved }: { onclose?: () => void; onsaved?: (root: string) => void } = $props();

  let currentRoot = $state(""); // the persisted root (display form)
  let listing = $state<DirListing | null>(null);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);

  async function browse(path?: string) {
    loading = true;
    error = null;
    try {
      listing = await listDirs(path);
    } catch (e) {
      error = e instanceof Error ? e.message : "failed to list directory";
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    try {
      const s = await getSettings();
      currentRoot = s.repoRootDisplay;
      await browse(s.repoRoot);
    } catch {
      await browse();
    }
  });

  const isCurrent = $derived(
    listing != null && currentRoot !== "" && listing.display === currentRoot,
  );

  async function useThisFolder() {
    if (!listing || saving) return;
    saving = true;
    error = null;
    try {
      const s = await putSettings(listing.path);
      currentRoot = s.repoRootDisplay;
      onsaved?.(s.repoRoot);
      onclose?.();
    } catch (e) {
      error = e instanceof Error ? e.message : "failed to save";
      saving = false;
    }
  }
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose?.();
  }}
>
  <div class="card bracket">
    <div class="chead">
      <span class="micro">Settings</span>
      <button type="button" class="x" onclick={() => onclose?.()} aria-label="close">✕</button>
    </div>

    <div class="cur">
      <span class="micro">Current&nbsp;Repo&nbsp;Root</span>
      <code>{currentRoot || "—"}</code>
    </div>

    <span class="micro path-label">Browse</span>
    <div class="crumbs">
      <button
        type="button"
        class="up"
        disabled={!listing?.parent || loading}
        onclick={() => listing?.parent && browse(listing.parent)}
        title="Up one level"
      >
        ↑
      </button>
      <code class="here">{listing?.display ?? "…"}</code>
    </div>

    <div class="list">
      {#if loading}
        <div class="placeholder">Loading…</div>
      {:else if listing && listing.entries.length === 0}
        <div class="placeholder">no sub-folders here</div>
      {:else if listing}
        {#each listing.entries as e (e.path)}
          <button type="button" class="row" onclick={() => browse(e.path)}>
            <span class="ico">📁</span><span class="nm">{e.name}</span>
            <span class="chev">›</span>
          </button>
        {/each}
      {/if}
    </div>

    {#if error}<div class="err">{error}</div>{/if}

    <button
      class="run"
      type="button"
      disabled={!listing || saving || isCurrent}
      onclick={useThisFolder}
    >
      {#if saving}
        Saving…
      {:else if isCurrent}
        Already the current root
      {:else}
        Use this folder
      {/if}
    </button>
    <SteersEditor />
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(3, 6, 5, 0.66);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 20;
  }
  .card {
    position: relative;
    width: min(520px, 92vw);
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .bracket::before,
  .bracket::after {
    content: "";
    position: absolute;
    width: 10px;
    height: 10px;
    border: 1px solid var(--color-line-bright);
  }
  .bracket::before {
    top: -1px;
    left: -1px;
    border-right: 0;
    border-bottom: 0;
  }
  .bracket::after {
    bottom: -1px;
    right: -1px;
    border-left: 0;
    border-top: 0;
  }
  .chead {
    display: flex;
    align-items: center;
    margin-bottom: 4px;
  }
  .x {
    margin-left: auto;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
  }
  .micro {
    font-size: 10.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .cur {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    padding: 8px 10px;
    border-radius: 2px;
  }
  .cur code {
    color: var(--color-amber);
    font-size: 12.5px;
    word-break: break-all;
  }
  .path-label {
    margin-top: 4px;
  }
  .crumbs {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .up {
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    color: var(--color-ink);
    font: inherit;
    font-size: 14px;
    line-height: 1;
    padding: 5px 9px;
    border-radius: 2px;
    cursor: pointer;
  }
  .up:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .here {
    color: var(--color-ink-bright);
    font-size: 12.5px;
    word-break: break-all;
  }
  .list {
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    border-radius: 2px;
    max-height: 280px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .placeholder {
    padding: 14px 12px;
    color: var(--color-faint);
    font-size: 11.5px;
    letter-spacing: 0.06em;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 9px;
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: 13px;
    text-align: left;
    padding: 9px 11px;
    cursor: pointer;
  }
  .row:last-child {
    border-bottom: 0;
  }
  .row:hover {
    background: var(--color-panel);
  }
  .ico {
    opacity: 0.85;
  }
  .nm {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chev {
    color: var(--color-faint);
  }
  .err {
    color: var(--color-red);
    font-size: 11.5px;
    margin-top: 2px;
  }
  .run {
    margin-top: 8px;
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    background: transparent;
    padding: 9px 14px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  .run:disabled {
    opacity: 0.5;
    cursor: default;
    box-shadow: none;
  }

  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
    }
    .card {
      width: 100%;
      max-width: none;
      height: 100dvh;
      border: 0;
      overflow-y: auto;
    }
    .list {
      max-height: none;
      flex: 1;
    }
    .row,
    .up,
    .run {
      min-height: 44px;
    }
  }
</style>
