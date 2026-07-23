<script lang="ts">
  import { putSettings } from "$lib/api";
  import DirPicker from "$lib/components/DirPicker.svelte";
  import { type DirListing } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import HighlightText from "./HighlightText.svelte";

  let {
    repoRoot,
    repoRootDisplay,
    settingsLoaded,
    onsaved,
    onclose,
    query = "",
  }: {
    // resolved by the parent's single getSettings() call (no second fetch here):
    // repoRoot drives the initial browse, repoRootDisplay is the current-root label.
    // null until the load settles (or if it failed). settingsLoaded flips once it has.
    repoRoot: string | null;
    repoRootDisplay: string | null;
    settingsLoaded: boolean;
    onsaved?: (root: string) => void;
    onclose?: () => void;
    /** Active settings-search query — highlights the panel's indexed labels. */
    query?: string;
  } = $props();

  // the persisted root (display form), authoritative from the parent
  const currentRoot = $derived(repoRootDisplay ?? "");
  // the directory DirPicker is currently browsing — the save candidate
  let listing = $state<DirListing | null>(null);
  let saving = $state(false);
  let error = $state<string | null>(null);

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
  <span class="micro"><HighlightText text={m.settings_current_root_label()} {query} /></span>
  <code>{currentRoot || "—"}</code>
</div>

<DirPicker initialPath={repoRoot} ready={settingsLoaded} bind:listing />

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
    <HighlightText text={m.settings_use_folder()} {query} />
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
    .run {
      min-height: 44px;
    }
  }
</style>
