<script lang="ts">
  import { onMount } from "svelte";
  import {
    getSettings,
    putSettings,
    putRemoteControl,
    putStandardCommand,
    listDirs,
  } from "$lib/api";
  import type { DirListing, HerdrUpdateStatus } from "$lib/types";
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

  // Settings group into three jobs so the modal never outgrows the viewport:
  // WORKSPACE (which repo root), SESSION (how agents start + steer), DEVICE
  // (this browser's notifications + theme). The HERDR-update CTA is an alert,
  // not a section, so it stays pinned above the tab strip.
  const TABS = [
    { id: "workspace", label: m.settings_tab_workspace },
    { id: "session", label: m.settings_tab_session },
    { id: "device", label: m.settings_tab_device },
  ] as const;
  type TabId = (typeof TABS)[number]["id"];
  let tab = $state<TabId>("workspace");
  let tabEls: HTMLButtonElement[] = [];

  function onTabKey(e: KeyboardEvent, i: number) {
    let next: number;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
      next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    else return;
    e.preventDefault();
    tab = TABS[next].id;
    tabEls[next]?.focus();
  }

  let {
    onclose,
    onsaved,
    herdrUpdate = null,
    onherdrupdate,
  }: {
    onclose?: () => void;
    onsaved?: (root: string) => void;
    herdrUpdate?: HerdrUpdateStatus | null;
    onherdrupdate?: () => void;
  } = $props();

  // On a phone the HERDR badge folds into the gear; its update flow lands here.
  const herdrUpdateAvailable = $derived(!!herdrUpdate && herdrUpdate.updateAvailable);

  let currentRoot = $state(""); // the persisted root (display form)
  let listing = $state<DirListing | null>(null);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let push = $state<PushStatus>({ supported: false, permission: "unsupported", subscribed: false });
  let pushBusy = $state(false);
  let remoteControl = $state(false); // Claude Code Remote Control auto-start in sessions
  let rcBusy = $state(false);
  let standardCommand = $state(""); // prompt behind the backlog ⚡ Standard button
  let scBusy = $state(false);
  let scSaved = $state(false); // brief "saved" confirmation after a successful save

  async function saveStandardCommand() {
    if (scBusy) return;
    scBusy = true;
    scSaved = false;
    try {
      const r = await putStandardCommand(standardCommand);
      standardCommand = r.standardCommand;
      scSaved = true;
    } finally {
      scBusy = false;
    }
  }

  async function toggleRemoteControl() {
    if (rcBusy) return;
    rcBusy = true;
    const next = !remoteControl;
    try {
      const s = await putRemoteControl(next);
      remoteControl = s.remoteControlAtStartup;
    } finally {
      rcBusy = false;
    }
  }

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
      remoteControl = s.remoteControlAtStartup;
      standardCommand = s.standardCommand;
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

    {#if herdrUpdateAvailable}
      <button type="button" class="herdr-cta" onclick={() => onherdrupdate?.()}>
        <span class="hc-dot" aria-hidden="true">▲</span>
        <span class="hc-text">
          <span class="hc-label">{m.settings_herdr_update_label()}</span>
          <span class="hc-ver"
            >{m.topbar_herdr_update_title({
              current: herdrUpdate!.current ?? "?",
              latest: herdrUpdate!.latest ?? "?",
            })}</span
          >
        </span>
        <span class="hc-chev" aria-hidden="true">›</span>
      </button>
    {/if}

    <div class="tabs" role="tablist" aria-label={m.settings_tabs_aria()}>
      {#each TABS as t, i (t.id)}
        <button
          type="button"
          role="tab"
          id="settings-tab-{t.id}"
          class="tab"
          class:on={tab === t.id}
          aria-selected={tab === t.id}
          aria-controls="settings-panel-{t.id}"
          tabindex={tab === t.id ? 0 : -1}
          bind:this={tabEls[i]}
          onclick={() => (tab = t.id)}
          onkeydown={(e) => onTabKey(e, i)}>{t.label()}</button
        >
      {/each}
    </div>

    <!-- All three panels stay mounted and toggle via `hidden`: every
         settings-panel-* id resolves for the tabs' aria-controls, and the
         steers editor keeps any in-progress draft across tab switches
         instead of remounting and resyncing from the store. -->
    <div
      class="panel"
      role="tabpanel"
      id="settings-panel-workspace"
      aria-labelledby="settings-tab-workspace"
      tabindex="0"
      hidden={tab !== "workspace"}
    >
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
    </div>

    <div
      class="panel"
      role="tabpanel"
      id="settings-panel-session"
      aria-labelledby="settings-tab-session"
      tabindex="0"
      hidden={tab !== "session"}
    >
      <div class="rc">
        <span class="micro">{m.settings_remote_control_title()}</span>
        <p class="hint">{m.settings_remote_control_hint()}</p>
        <button
          type="button"
          class="toggle"
          role="switch"
          aria-checked={remoteControl}
          disabled={rcBusy}
          onclick={toggleRemoteControl}
        >
          <span class="track" class:on={remoteControl}><span class="knob"></span></span>
          <span class="state"
            >{remoteControl
              ? m.settings_remote_control_on()
              : m.settings_remote_control_off()}</span
          >
        </button>
      </div>
      <div class="sc">
        <span class="micro">{m.settings_standard_command_title()}</span>
        <p class="hint">{m.settings_standard_command_hint()}</p>
        <textarea
          class="sc-input"
          rows="4"
          bind:value={standardCommand}
          oninput={() => (scSaved = false)}
          placeholder={m.settings_standard_command_placeholder()}
        ></textarea>
        <button type="button" class="run" disabled={scBusy} onclick={saveStandardCommand}>
          {#if scBusy}
            {m.settings_saving()}
          {:else if scSaved}
            {m.settings_standard_command_saved()}
          {:else}
            {m.settings_standard_command_save()}
          {/if}
        </button>
      </div>
      <SteersEditor />
    </div>

    <div
      class="panel"
      role="tabpanel"
      id="settings-panel-device"
      aria-labelledby="settings-tab-device"
      tabindex="0"
      hidden={tab !== "device"}
    >
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
    </div>
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
    max-height: 86vh;
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
  }
  /* Tab strip: muted labels, active marked by amber text + underline (never a
     filled tab). The strip's hairline is the divider; the active tab overlaps
     it with a 2px amber border. */
  .tabs {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid var(--color-line);
  }
  .tab {
    background: transparent;
    border: 0;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    color: var(--color-muted);
    font: inherit;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 8px 12px;
    cursor: pointer;
  }
  .tab:hover {
    color: var(--color-ink);
  }
  .tab.on {
    color: var(--color-amber);
    border-bottom-color: var(--color-amber);
  }
  .tab:focus-visible {
    outline: 1px solid var(--color-line-bright);
    outline-offset: -2px;
  }
  /* Only the active tab's content lives here; it carries the scroll so a tall
     tab (many steers) stays inside the bounded card instead of overflowing. */
  /* `:not([hidden])` carries `display` so the `hidden` attribute on inactive
     panels still collapses them (author `display` would otherwise beat the UA
     `[hidden] { display: none }`). */
  .panel:not([hidden]) {
    display: flex;
  }
  .panel {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    flex-direction: column;
    gap: 8px;
  }
  .panel:focus-visible {
    outline: none;
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
  /* Folded HERDR-update entry point (green, matching the badge it replaces). */
  .herdr-cta {
    display: flex;
    align-items: center;
    gap: 10px;
    text-align: left;
    border: 1px solid var(--color-green);
    background: color-mix(in srgb, var(--color-green) 12%, transparent);
    border-radius: 2px;
    padding: 10px 12px;
    cursor: pointer;
    font: inherit;
    color: var(--color-ink-bright);
  }
  .herdr-cta .hc-dot {
    color: var(--color-green);
    font-size: 9px;
  }
  .herdr-cta .hc-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .herdr-cta .hc-label {
    color: var(--color-green);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .herdr-cta .hc-ver {
    color: var(--color-muted);
    font-size: 12px;
  }
  .herdr-cta .hc-chev {
    color: var(--color-green);
    font-size: 18px;
    line-height: 1;
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
  }
  .push .hint {
    color: var(--color-faint);
    font-size: 11.5px;
    margin: 0;
  }
  .rc {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .rc .hint {
    color: var(--color-faint);
    font-size: 11.5px;
    margin: 0;
  }
  .sc {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sc .hint {
    color: var(--color-faint);
    font-size: 11.5px;
    margin: 0;
  }
  .sc-input {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    min-height: 72px;
    border: 1px solid var(--color-line-bright);
    background: var(--color-inset);
    color: var(--color-ink-bright);
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.5;
    padding: 8px 10px;
    border-radius: 2px;
  }
  .sc-input:focus {
    outline: none;
    border-color: var(--color-amber);
  }
  .sc .run {
    align-self: flex-start;
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 10px;
    align-self: flex-start;
    background: transparent;
    border: 0;
    padding: 4px 0;
    cursor: pointer;
    font: inherit;
    min-height: 44px;
  }
  .toggle:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .track {
    position: relative;
    width: 38px;
    height: 20px;
    border: 1px solid var(--color-line-bright);
    border-radius: 10px;
    background: var(--color-inset);
    transition: background 0.12s;
  }
  .track.on {
    background: color-mix(in srgb, var(--color-amber) 22%, transparent);
    border-color: var(--color-amber);
  }
  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--color-muted);
    transition:
      transform 0.12s,
      background 0.12s;
  }
  .track.on .knob {
    transform: translateX(18px);
    background: var(--color-amber);
  }
  .toggle .state {
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-ink-bright);
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
    }
    .card {
      width: 100%;
      max-width: none;
      height: 100dvh;
      max-height: none;
      border: 0;
      overflow: hidden;
    }
    .list {
      max-height: 50vh;
    }
    .row,
    .up,
    .run {
      min-height: 44px;
    }
  }
</style>
