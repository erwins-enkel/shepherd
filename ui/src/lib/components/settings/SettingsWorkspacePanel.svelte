<script lang="ts">
  import { listDirs, putSettings } from "$lib/api";
  import { type DirListing } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  let {
    repoRoot,
    repoRootDisplay,
    settingsLoaded,
    onsaved,
    onclose,
  }: {
    // resolved by the parent's single getSettings() call (no second fetch here):
    // repoRoot drives the initial browse, repoRootDisplay is the current-root label.
    // null until the load settles (or if it failed). settingsLoaded flips once it has.
    repoRoot: string | null;
    repoRootDisplay: string | null;
    settingsLoaded: boolean;
    onsaved?: (root: string) => void;
    onclose?: () => void;
  } = $props();

  // the persisted root (display form), authoritative from the parent
  const currentRoot = $derived(repoRootDisplay ?? "");
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

  // Browse once the parent's settings load settles: into repoRoot on success,
  // or the default dir if it failed (repoRoot stays null). Guarded so a later
  // prop change can't re-trigger the initial listing.
  let browsed = false;
  $effect(() => {
    if (browsed || !settingsLoaded) return;
    browsed = true;
    void browse(repoRoot ?? undefined);
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
      // onsaved bubbles the new root up; onclose dismisses immediately, so the
      // displayed currentRoot (derived from the parent prop) needs no local write.
      onsaved?.(s.repoRoot);
      onclose?.();
    } catch (e) {
      error = e instanceof Error ? e.message : "failed to save";
      saving = false;
    }
  }
</script>

<div class="cur">
  <span class="micro">{m.settings_current_root_label()}</span>
  <code>{currentRoot || "—"}</code>
</div>

<span class="micro path-label">{m.settings_browse_label()}</span>
<div class="crumbs">
  <button
    type="button"
    class="up"
    disabled={!listing?.parent || loading}
    onclick={() => listing?.parent && browse(listing.parent)}
    title={m.settings_up_level()}
  >
    ↑
  </button>
  <code class="here">{listing?.display ?? "…"}</code>
</div>

<div class="list">
  {#if loading}
    <div class="placeholder">{m.settings_loading()}</div>
  {:else if listing && listing.entries.length === 0}
    <div class="placeholder">{m.settings_no_subfolders()}</div>
  {:else if listing}
    {#each listing.entries as e (e.path)}
      <button type="button" class="row" onclick={() => browse(e.path)}>
        <span class="ico">▸</span><span class="nm">{e.name}</span>
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
    {m.settings_saving()}
  {:else if isCurrent}
    {m.settings_already_current()}
  {:else}
    {m.settings_use_folder()}
  {/if}
</button>

<style>
  .micro {
    font-size: var(--fs-meta);
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
    font-size: var(--fs-base);
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
    font-size: var(--fs-lg);
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
    font-size: var(--fs-base);
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
    font-size: var(--fs-meta);
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
    font-size: var(--fs-base);
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
    font-size: var(--fs-meta);
    margin-top: 2px;
  }
  .run {
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    background: transparent;
    padding: 9px 14px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  .run:disabled {
    opacity: 0.5;
    cursor: default;
    box-shadow: none;
  }

  @media (max-width: 768px) {
    /* Lift the list cap on mobile: the list flexes to fill the bounded panel
       and stays the single scroll region (button pinned below), instead of a
       capped list nested inside a separately-scrolling panel. */
    .list {
      max-height: none;
    }
    .row,
    .up,
    .run {
      min-height: 44px;
    }
  }
</style>
