<script lang="ts">
  import { untrack } from "svelte";
  import { putSettings, putWarmRepoDays } from "#lib/api.js";
  import DirPicker from "#lib/components/DirPicker.svelte";
  import { type DirListing, type Settings } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { warmWindowExplanation } from "#lib/tooltips/explanations.js";
  import HighlightText from "./HighlightText.svelte";
  import SettingRow from "./SettingRow.svelte";
  import "./settings-controls.css";
  import SettingsHouseStackBlock from "./SettingsHouseStackBlock.svelte";
  import SettingsIssueFilterBlock from "./SettingsIssueFilterBlock.svelte";
  import SettingsRepoOverridesBlock from "./SettingsRepoOverridesBlock.svelte";

  let {
    repoRoot,
    repoRootDisplay,
    settingsLoaded,
    onsaved,
    onclose,
    query = "",
    payload = null,
    focusWorkspace = null,
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
    /** The parent's single getSettings() payload; seeds the House Stack block. */
    payload?: Settings | null;
    /** Group to expand + scroll into view on open (the Up Next flyout's link, #3020). */
    focusWorkspace?: "repo-overrides" | null;
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

  // Warm window (#2837): seeded once from the payload; null hides the row (older server).
  const WARM_MIN = 0;
  const WARM_MAX = 30;
  let warmDays = $state<number | null>(null);
  let warmDaysSaved = 0;
  let warmBusy = $state(false);
  $effect(() => {
    const days = payload?.warmRepoDays;
    if (typeof days === "number" && untrack(() => warmDays) === null) {
      warmDays = days;
      warmDaysSaved = days;
    }
  });

  async function saveWarmDays() {
    if (warmBusy || warmDays === null) return;
    warmBusy = true;
    // Clamp before sending (the server clamps too); an empty field keeps the saved value.
    const n = Math.round(Number(warmDays));
    const clamped = Number.isFinite(n) ? Math.min(WARM_MAX, Math.max(WARM_MIN, n)) : warmDaysSaved;
    warmDays = clamped;
    try {
      const r = await putWarmRepoDays(clamped);
      warmDays = r.warmRepoDays;
      warmDaysSaved = r.warmRepoDays;
    } catch {
      warmDays = warmDaysSaved;
      toasts.info(m.settings_warm_repo_days_save_failed(), { key: "warm-repo-days", alert: true });
    } finally {
      warmBusy = false;
    }
  }

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

{#if warmDays !== null}
  <div class="stack">
    <SettingRow
      title={m.settings_warm_repo_days_title()}
      description={m.settings_warm_repo_days_hint()}
      explanation={warmWindowExplanation()}
      {query}
    >
      {#snippet control()}
        <input
          class="set-num"
          type="number"
          min={WARM_MIN}
          max={WARM_MAX}
          step="1"
          disabled={warmBusy}
          bind:value={warmDays}
          aria-label={m.settings_warm_repo_days_title()}
          onchange={saveWarmDays}
        />
      {/snippet}
    </SettingRow>
  </div>
{/if}
<div class="stack"><SettingsHouseStackBlock {payload} {query} /></div>
<div class="stack"><SettingsIssueFilterBlock {query} /></div>
<div class="stack">
  <SettingsRepoOverridesBlock focus={focusWorkspace === "repo-overrides"} />
</div>

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
  .stack {
    margin-top: 12px;
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
