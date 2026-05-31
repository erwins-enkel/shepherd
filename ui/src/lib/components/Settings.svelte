<script lang="ts">
  import { onMount } from "svelte";
  import { getSettings, putSettings, listDirs } from "$lib/api";
  import type { DirListing } from "$lib/types";
  import SteersEditor from "$lib/components/SteersEditor.svelte";
  import { m } from "$lib/paraglide/messages";
  import { pushState, enablePush, disablePush, type PushStatus } from "$lib/push";
  import { theme, type ThemePref } from "$lib/theme.svelte";

  // Theme picker — mobile only: the desktop switcher lives in the ActionBar,
  // but on phones the ActionBar hides it and it was dropped from the top bar,
  // so Settings (reachable via the gear from any mobile screen) is its home.
  const THEMES: { pref: ThemePref; glyph: string; label: () => string }[] = [
    { pref: "dark", glyph: "☾", label: m.theme_dark },
    { pref: "light", glyph: "☀", label: m.theme_light },
    { pref: "system", glyph: "◐", label: m.theme_system },
  ];

  let { onclose, onsaved }: { onclose?: () => void; onsaved?: (root: string) => void } = $props();

  let currentRoot = $state(""); // the persisted root (display form)
  let listing = $state<DirListing | null>(null);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let push = $state<PushStatus>({ supported: false, permission: "unsupported", subscribed: false });
  let pushBusy = $state(false);

  async function refreshPush() {
    push = await pushState();
  }

  async function togglePush() {
    if (pushBusy) return;
    pushBusy = true;
    try {
      if (push.subscribed) await disablePush();
      else await enablePush();
      await refreshPush();
    } finally {
      pushBusy = false;
    }
  }

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
    await refreshPush();
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
      <span class="micro">{m.settings_title()}</span>
      <button type="button" class="x" onclick={() => onclose?.()} aria-label={m.common_close()}
        >✕</button
      >
    </div>

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
        {m.settings_saving()}
      {:else if isCurrent}
        {m.settings_already_current()}
      {:else}
        {m.settings_use_folder()}
      {/if}
    </button>
    <div class="theme-row">
      <span class="micro">{m.actionbar_theme_group_aria()}</span>
      <div class="theme-seg" role="group" aria-label={m.actionbar_theme_group_aria()}>
        {#each THEMES as t (t.pref)}
          <button
            type="button"
            class="t-opt"
            class:on={theme.pref === t.pref}
            aria-pressed={theme.pref === t.pref}
            aria-label={m.actionbar_theme_option({ label: t.label() })}
            onclick={() => theme.setPref(t.pref)}>{t.glyph}</button
          >
        {/each}
      </div>
    </div>
    <div class="push">
      <span class="micro">{m.settings_push_title()}</span>
      {#if !push.supported}
        <p class="hint">{m.settings_push_unsupported()}</p>
      {:else if push.permission === "denied"}
        <p class="hint">{m.settings_push_denied()}</p>
      {:else}
        <button type="button" class="run" disabled={pushBusy} onclick={togglePush}>
          {#if pushBusy}…{:else if push.subscribed}{m.settings_push_disable()}{:else}{m.settings_push_enable()}{/if}
        </button>
      {/if}
    </div>
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
  .push {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 8px;
  }
  .push .hint {
    color: var(--color-faint);
    font-size: 11.5px;
    margin: 0;
  }
  /* Desktop hosts the theme switcher in the ActionBar; only surface it here on
     mobile, where the ActionBar hides it and the top bar no longer carries it. */
  .theme-row {
    display: none;
  }
  .theme-seg {
    display: flex;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    overflow: hidden;
    align-self: flex-start;
  }
  .t-opt {
    background: transparent;
    border: 0;
    border-left: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    font-size: 16px;
    line-height: 1;
    padding: 0 16px;
    min-height: 44px;
    cursor: pointer;
  }
  .t-opt:first-child {
    border-left: 0;
  }
  .t-opt.on {
    color: var(--color-amber);
    background: var(--color-inset);
  }

  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
    }
    .theme-row {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 8px;
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
