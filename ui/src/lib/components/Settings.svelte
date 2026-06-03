<script lang="ts">
  import { onMount } from "svelte";
  import {
    getSettings,
    putSettings,
    putRemoteControl,
    putStandardCommand,
    putSessionHousekeeping,
    listDirs,
  } from "$lib/api";
  import type { DirListing, HerdrUpdateStatus } from "$lib/types";
  import SteersEditor from "$lib/components/SteersEditor.svelte";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";
  import {
    pushState,
    enablePush,
    disablePush,
    getPushCategories,
    setPushCategories,
    type PushStatus,
    type PushCategories,
  } from "$lib/push";
  import { theme, type ThemePref } from "$lib/theme.svelte";
  import { REPO, REPO_URL, sha, version, commitUrl } from "$lib/build-info";

  // Theme picker — mobile only: the desktop switcher lives in the ActionBar,
  // but on phones the ActionBar hides it and it was dropped from the top bar,
  // so Settings (reachable via the gear from any mobile screen) is its home.
  const THEMES: { pref: ThemePref; glyph: string; label: () => string }[] = [
    { pref: "dark", glyph: "☾", label: m.theme_dark },
    { pref: "light", glyph: "☀", label: m.theme_light },
    { pref: "system", glyph: "◐", label: m.theme_system },
  ];

  // Build/repo facts ($lib/build-info) come from the same source the desktop
  // ActionBar footer uses. That footer is hidden on mobile, so the Device tab is
  // where phone users read them (mirrors the theme picker, surfaced for the same
  // reason).

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
    onclone,
    herdrUpdate = null,
    onherdrupdate,
  }: {
    onclose?: () => void;
    onsaved?: (root: string) => void;
    onclone?: () => void;
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
  let categories = $state<PushCategories>({ agent: true, reviews: true, ci: true });

  // Category metadata drives the checkbox list; keys index into `categories`.
  const categoryRows: { key: keyof PushCategories; label: () => string }[] = [
    { key: "agent", label: () => m.settings_push_cat_agent() },
    { key: "reviews", label: () => m.settings_push_cat_reviews() },
    { key: "ci", label: () => m.settings_push_cat_ci() },
  ];
  let remoteControl = $state(false); // Claude Code Remote Control auto-start in sessions
  let rcBusy = $state(false);
  let standardCommand = $state(""); // prompt behind the backlog ⚡ Standard button
  let scBusy = $state(false);
  let scSaved = $state(false); // brief "saved" confirmation after a successful save
  let housekeeping = $state(true); // daily prune of old archived sessions (kill switch)
  let hkBusy = $state(false);
  let retentionDays = $state(30); // display-only, from the settings payload
  let retentionKeep = $state(250); // display-only, from the settings payload

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

  async function toggleHousekeeping() {
    if (hkBusy) return;
    hkBusy = true;
    const next = !housekeeping;
    try {
      const s = await putSessionHousekeeping(next);
      housekeeping = s.sessionHousekeepingEnabled;
    } finally {
      hkBusy = false;
    }
  }

  async function refreshPush() {
    push = await pushState();
    if (push.subscribed) categories = await getPushCategories();
  }

  async function toggleCategory(key: keyof PushCategories) {
    const prev = categories;
    const next = { ...categories, [key]: !categories[key] };
    categories = next; // optimistic; server is authoritative at send time
    if (!(await setPushCategories(next))) categories = prev; // persist failed → revert
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
      housekeeping = s.sessionHousekeepingEnabled;
      retentionDays = s.sessionRetentionDays;
      retentionKeep = s.sessionRetentionKeep;
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
  <div
    class="card bracket"
    role="dialog"
    aria-modal="true"
    aria-label={m.settings_title()}
    use:dialog={{ onclose: () => onclose?.() }}
  >
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
      {#if onclone}
        <button type="button" class="clone-trigger" onclick={() => onclone?.()}
          >{m.clonerepo_trigger()}</button
        >
      {/if}
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
      <div class="rc">
        <span class="micro">{m.settings_housekeeping_title()}</span>
        <p class="hint">
          {m.settings_housekeeping_hint({ days: retentionDays, count: retentionKeep })}
        </p>
        <button
          type="button"
          class="toggle"
          role="switch"
          aria-checked={housekeeping}
          disabled={hkBusy}
          onclick={toggleHousekeeping}
        >
          <span class="track" class:on={housekeeping}><span class="knob"></span></span>
          <span class="state"
            >{housekeeping ? m.settings_housekeeping_on() : m.settings_housekeeping_off()}</span
          >
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
          {#if push.subscribed}
            <fieldset class="cats">
              <legend class="micro">{m.settings_push_cat_title()}</legend>
              {#each categoryRows as row (row.key)}
                <label class="cat">
                  <input
                    type="checkbox"
                    checked={categories[row.key]}
                    onchange={() => toggleCategory(row.key)}
                  />
                  <span>{row.label()}</span>
                </label>
              {/each}
            </fieldset>
          {/if}
        {/if}
      </div>
      <div class="about">
        <span class="micro">{m.settings_about_title()}</span>
        <dl class="about-grid">
          <dt>{m.settings_about_version()}</dt>
          <dd>v{version}</dd>
          <dt>{m.settings_about_commit()}</dt>
          <dd>
            <a
              href={commitUrl}
              target="_blank"
              rel="external noreferrer noopener"
              title={m.actionbar_commit_title({ sha })}>{sha}</a
            >
          </dd>
          <dt>{m.settings_about_repo()}</dt>
          <dd>
            <a
              href={REPO_URL}
              target="_blank"
              rel="external noreferrer noopener"
              title={m.actionbar_repo_link({ repo: REPO })}>{REPO}</a
            >
          </dd>
        </dl>
      </div>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--color-scrim);
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
  /* Keyboard focus on the scrollable tabpanel gets a quiet inset hairline
     rather than no ring at all (it's a tabindex=0 stop). */
  .panel:focus-visible {
    outline: 1px solid var(--color-line-bright);
    outline-offset: -2px;
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
  /* Secondary/outline button — same shape as .run but uses the panel's neutral
     line colour rather than amber, so it reads as a lower-priority action. */
  .clone-trigger {
    border: 1px solid var(--color-line-bright);
    color: var(--color-ink);
    background: var(--color-inset);
    padding: 9px 14px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .clone-trigger:hover {
    color: var(--color-ink-bright);
    border-color: var(--color-ink);
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
  .cats {
    display: flex;
    flex-direction: column;
    gap: 6px;
    border: 0;
    margin: 2px 0 0;
    padding: 0;
  }
  .cats legend {
    padding: 0;
    margin-bottom: 4px;
  }
  .cat {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    cursor: pointer;
  }
  .cat input {
    cursor: pointer;
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
    border-color: var(--color-line-bright);
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
    border-radius: 2px;
    background: var(--color-inset);
    transition: background 0.12s;
  }
  .track.on {
    background: color-mix(in srgb, var(--color-ink) 22%, transparent);
    border-color: var(--color-line-bright);
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
    background: var(--color-ink-bright);
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
  /* Version / commit / repo — desktop reads these from the ActionBar footer,
     so surface them here only on mobile, where that footer is hidden. */
  .about {
    display: none;
    flex-direction: column;
    gap: 6px;
    margin-top: 4px;
    border-top: 1px solid var(--color-line);
    padding-top: 12px;
  }
  .about-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 14px;
    margin: 0;
  }
  .about-grid dt {
    color: var(--color-faint);
    font-size: 11.5px;
    letter-spacing: 0.06em;
  }
  .about-grid dd {
    margin: 0;
    font-size: 12.5px;
    color: var(--color-ink-bright);
    word-break: break-all;
  }
  .about-grid a {
    color: var(--color-amber);
    text-decoration: none;
  }
  .about-grid a:hover {
    text-decoration: underline;
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
    .about {
      display: flex;
    }
    .card {
      width: 100%;
      max-width: none;
      height: 100dvh;
      max-height: none;
      border: 0;
      overflow: hidden;
    }
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
