<script lang="ts">
  // Shared directory-browse widget, extracted out of SettingsWorkspacePanel so both
  // the Settings → Workspace panel and the first-run onboarding gate (Onboarding.svelte)
  // browse the filesystem the same way. Owns browsing/listing/loading/error state; the
  // caller owns everything above it (a "current root" label, the save action + its own
  // busy/error state) since those differ between the two call sites.
  import { listDirs } from "$lib/api";
  import { type DirListing } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  let {
    initialPath,
    ready,
    listing = $bindable(null),
  }: {
    // Directory the first browse should open into; null/undefined browses the server default.
    initialPath: string | null | undefined;
    // True once the caller's own settings load has settled (success or failure) — gates the
    // first browse so this doesn't race an in-flight parent fetch.
    ready: boolean;
    // The currently-browsed directory — the caller's "chosen path" candidate (listing.path /
    // listing.display). Bindable so callers can read it to drive their own save action.
    listing?: DirListing | null;
  } = $props();

  let loading = $state(false);
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

  // Browse once the parent's settings load settles: into initialPath on success, or the
  // default dir if it failed (initialPath stays null). Guarded so a later prop change can't
  // re-trigger the initial listing.
  let browsed = false;
  $effect(() => {
    if (browsed || !ready) return;
    browsed = true;
    void browse(initialPath ?? undefined);
  });
</script>

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

<style>
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
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

  @media (max-width: 768px) {
    /* Lift the list cap on mobile: the list flexes to fill the bounded panel and stays the
       single scroll region (button pinned below by the caller), instead of a capped list
       nested inside a separately-scrolling panel. */
    .list {
      max-height: none;
    }
    .row,
    .up {
      min-height: 44px;
    }
  }
</style>
