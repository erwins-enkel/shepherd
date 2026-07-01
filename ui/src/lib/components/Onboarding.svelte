<script lang="ts">
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";
  import { putSettings } from "$lib/api";
  import DiagnoseRows from "$lib/components/DiagnoseRows.svelte";
  import DirPicker from "$lib/components/DirPicker.svelte";
  import type { DiagnosticCheck, DirListing } from "$lib/types";

  let {
    checks,
    failed = false,
    onretry,
    ondismiss,
    blocking = false,
    repoRoot = null,
    repoRootDisplay = null,
    settingsLoaded = false,
    onpicked,
  }: {
    checks: DiagnosticCheck[] | null;
    failed?: boolean;
    onretry?: () => void;
    /** Non-blocking-mode close (Dismiss button + Esc). Ignored while `blocking` is true. */
    ondismiss?: () => void;
    /** True on a genuine server-reported first run (`settings.firstRunPending`): hides Dismiss,
     *  blocks Esc close, and requires a folder pick (see `onpicked`) before the gate can clear —
     *  the server is the source of truth, not the localStorage feature-discovery "seen" latch. */
    blocking?: boolean;
    /** Seed path for the folder picker's initial browse (the server's current repoRoot). */
    repoRoot?: string | null;
    /** The server's current default root, shown informationally above the picker while
     *  blocking (so the operator sees what's already configured before overriding it). */
    repoRootDisplay?: string | null;
    /** True once the caller's settings load has settled — gates the picker's first browse. */
    settingsLoaded?: boolean;
    /** Fires with the newly-persisted root once `putSettings` succeeds in blocking mode, so the
     *  parent can clear the gate (`showOnboarding = false`). */
    onpicked?: (root: string) => void;
  } = $props();

  let listing = $state<DirListing | null>(null);
  let saving = $state(false);
  let error = $state<string | null>(null);

  async function useThisFolder() {
    if (!listing || saving) return;
    saving = true;
    error = null;
    try {
      const s = await putSettings(listing.path);
      onpicked?.(s.repoRoot);
    } catch (e) {
      error = e instanceof Error ? e.message : "failed to save";
      saving = false;
    }
  }

  // Blocking mode must not let Escape close the surface (design rule: the operator must pick a
  // root first) — only wire the dialog action's onclose when a dismiss is actually allowed.
  const dialogClose = $derived(blocking ? undefined : ondismiss);
</script>

<!-- Blocking first-run surface over the app: canonical scrim backdrop (design
     system rule #5) — the global `.scrim` class provides the dim + blur. -->
<div class="scrim" role="presentation">
  <div
    class="card"
    role="dialog"
    aria-modal="true"
    aria-labelledby="onboarding-title"
    use:dialog={{ onclose: dialogClose }}
  >
    <header class="head">
      {#if blocking}
        <h2 class="title" id="onboarding-title">{m.onboarding_pick_root_title()}</h2>
        <p class="intro">{m.onboarding_pick_root_intro()}</p>
      {:else}
        <h2 class="title" id="onboarding-title">{m.onboarding_title()}</h2>
        <p class="intro">{m.onboarding_intro()}</p>
      {/if}
    </header>
    <div class="body">
      {#if blocking}
        <div class="picker">
          {#if repoRootDisplay}
            <div class="cur">
              <span class="micro">{m.settings_current_root_label()}</span>
              <code>{repoRootDisplay}</code>
            </div>
          {/if}
          <DirPicker initialPath={repoRoot} ready={settingsLoaded} bind:listing />
          {#if error}<div class="err">{error}</div>{/if}
        </div>
      {/if}
      <div class="checks">
        <DiagnoseRows {checks} {failed} {onretry} />
      </div>
    </div>
    <footer class="foot">
      {#if blocking}
        <button class="gbtn primary" disabled={!listing || saving} onclick={useThisFolder}>
          {#if saving}
            {m.settings_saving()}
          {:else}
            {m.onboarding_pick_root_confirm()}
          {/if}
        </button>
      {:else}
        <button class="gbtn primary" onclick={ondismiss}>{m.onboarding_dismiss()}</button>
      {/if}
    </footer>
  </div>
</div>

<style>
  /* The global `.scrim` (app.css) supplies background + blur; we only add the
     positioning context + z-index to float the card centered above the app. */
  .scrim {
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: calc(16px + env(safe-area-inset-top)) 16px calc(16px + env(safe-area-inset-bottom));
  }
  .card {
    width: min(440px, 100%);
    max-height: 100%;
    display: flex;
    flex-direction: column;
    gap: 14px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 10px;
    padding: 20px;
    overflow: hidden;
  }
  .head {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex-shrink: 0;
  }
  .title {
    margin: 0;
    font-size: var(--fs-lg);
    color: var(--color-ink);
  }
  .intro {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.5;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 14px;
    overflow-y: auto;
    min-height: 0;
  }
  .picker {
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex-shrink: 0;
  }
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
  }
  .checks {
    min-height: 0;
  }
  .foot {
    display: flex;
    justify-content: flex-end;
    flex-shrink: 0;
  }
  /* Canonical button recipe (.gbtn) — see /design-system. */
  .gbtn {
    background: none;
    border: 1px solid var(--color-line-bright);
    border-radius: 6px;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-base);
    padding: 7px 16px;
    cursor: pointer;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
