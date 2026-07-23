<script lang="ts">
  import { onMount } from "svelte";
  import { m } from "$lib/paraglide/messages";
  import HighlightText from "./HighlightText.svelte";
  import {
    getInstalledPlugins,
    installPlugin,
    uninstallPlugin,
    activatePlugin,
    checkPluginUpdates,
    applyPluginUpdate,
  } from "$lib/api";
  import type {
    PluginInfo,
    InstalledPlugin,
    PluginUpdatesStatus,
    PluginUpdateInfo,
  } from "$lib/types";
  import PluginLoadedCard from "./PluginLoadedCard.svelte";
  import PluginConfirmDialog from "./PluginConfirmDialog.svelte";
  import RestartShepherdDialog from "$lib/components/RestartShepherdDialog.svelte";

  let {
    plugins = [],
    onpluginschanged,
    focusId = null,
    updates = null,
    onpluginapplied,
    query = "",
  }: {
    plugins?: PluginInfo[];
    /** Called after an in-process activation so the parent can re-seed `store.plugins`
     *  (a freshly-loaded id must land in the store for the row to flip to a loaded card
     *  and for its gear/UI pushes to stop no-opping). */
    onpluginschanged?: () => void;
    focusId?: string | null;
    /** Store-fed update snapshot; per-plugin "update available" state renders from it.
     *  A manual check needs NO callback — the server broadcasts `plugin-update:status`
     *  and this prop re-renders from the store. */
    updates?: PluginUpdatesStatus | null;
    /** After an inline apply: push the recomputed snapshot up (same contract as the
     *  updates modal's `onapplied`) so the badge/CTA + loaded-plugin list refresh. */
    onpluginapplied?: (status: PluginUpdatesStatus) => void;
    /** Active settings-search query — highlights the panel's indexed labels. */
    query?: string;
  } = $props();

  // On-disk plugin folders (install manager). Self-fetched — the live `plugins` prop only
  // carries LOADED plugins; the scan additionally surfaces pending-restart/disabled/broken.
  let installed = $state<InstalledPlugin[]>([]);
  let loading = $state(true);
  // Only true after a SUCCESSFUL scan. "removed" (loaded but folder gone) is derived from
  // absence-in-scan, so we must not infer it while the scan is unloaded/failed — otherwise a
  // network blip would wrongly mark every loaded plugin as removed.
  let scanLoaded = $state(false);

  let url = $state("");
  let installing = $state(false);
  let busyFolder = $state<string | null>(null); // folder mid-uninstall
  let actionError = $state<string | null>(null);
  let copied = $state(false);

  // Blocking confirm — trust warning before an install, plain confirm before an uninstall.
  type Confirm =
    | { kind: "install"; url: string }
    | { kind: "uninstall"; folder: string; name: string; loaded: boolean };
  let confirm = $state<Confirm | null>(null);
  let restartOpen = $state(false); // the one-click Restart-Shepherd dialog
  let restartAutoStart = $state(false);

  const RESTART_CMD = "systemctl --user restart shepherd";

  async function loadInstalled() {
    loading = true;
    try {
      installed = await getInstalledPlugins();
      scanLoaded = true;
    } catch {
      // Non-fatal: an older core without the management routes still shows the loaded list
      // (rendered straight from the `plugins` prop; no uninstall/removed inference).
      installed = [];
      scanLoaded = false;
    } finally {
      loading = false;
    }
  }
  onMount(loadInstalled);

  /** UNION by id of the live loaded `plugins` and the on-disk scan. Shapes:
   *  - a loaded plugin → rich card (with its folder from the scan, when known, for uninstall);
   *  - a loaded plugin absent from a SUCCESSFUL scan (its folder was just uninstalled but it
   *    is still running in-process) → a "removed, restart to unload" row (no uninstall);
   *  - an on-disk folder not loaded → pending-restart / disabled / broken row. */
  type Row =
    | { kind: "loaded"; info: PluginInfo; folder: string | null }
    | { kind: "pending" | "disabled" | "broken"; inst: InstalledPlugin }
    | { kind: "removed"; info: PluginInfo };

  const rows = $derived.by((): Row[] => {
    const scanById = new Map(installed.filter((i) => !i.broken).map((i) => [i.id, i]));
    const loadedIds = new Set(plugins.map((p) => p.id));
    const out: Row[] = [];
    // Loaded plugins first (rich cards), in their existing order.
    for (const p of plugins) {
      const inst = scanById.get(p.id);
      if (scanLoaded && !inst) out.push({ kind: "removed", info: p });
      else out.push({ kind: "loaded", info: p, folder: inst?.folder ?? null });
    }
    // On-disk folders that aren't loaded → pending / disabled / broken.
    for (const inst of installed) {
      if (inst.broken) {
        out.push({ kind: "broken", inst });
        continue;
      }
      if (loadedIds.has(inst.id)) continue; // already rendered as a loaded card
      out.push({ kind: inst.disabled ? "disabled" : "pending", inst });
    }
    return out;
  });

  // ── installed-plugin updates (in-card badge + inline apply + manual check) ──

  const updById = $derived(new Map((updates?.plugins ?? []).map((u) => [u.id, u])));
  function availableUpdate(id: string): PluginUpdateInfo | null {
    const u = updById.get(id);
    return u && u.state === "update-available" ? u : null;
  }

  // Manual "Check now": the response is awaited only for the busy state — the row
  // re-render comes from the server's `plugin-update:status` broadcast via `updates`.
  let checking = $state(false);
  let checkFailed = $state(false);
  async function runCheck() {
    if (checking) return;
    checking = true;
    checkFailed = false;
    try {
      await checkPluginUpdates();
    } catch {
      checkFailed = true;
    } finally {
      checking = false;
    }
  }
  const lastChecked = $derived(
    updates
      ? new Date(updates.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : null,
  );

  // Per-id apply state (mirrors PluginUpdatesModal.applyOne): `applyBusy` guards a
  // double-click; `applyOutcome` persists a live/restart/error note that survives the
  // snapshot refresh (a just-updated plugin drops to `up-to-date` and would otherwise
  // lose its "restart to finish" hint).
  type ApplyOutcome =
    { kind: "live" | "restart"; version: string } | { kind: "error"; msg: string; detail?: string };
  let applyBusy = $state<Record<string, boolean>>({});
  let applyOutcome = $state<Record<string, ApplyOutcome>>({});

  /** Map a stable apply-error CODE to a message (mirrors the updates modal). */
  function applyErrMessage(code: string): string {
    switch (code) {
      case "symlinked_source":
        return m.pluginupdate_apply_err_symlinked();
      case "incompatible":
        return m.pluginupdate_apply_err_incompatible();
      case "no_source":
        return m.pluginupdate_apply_err_nosource();
      default:
        return m.pluginupdate_apply_err_generic();
    }
  }

  async function runUpdate(id: string) {
    const u = availableUpdate(id);
    if (!u || applyBusy[id]) return;
    // Never re-apply a plugin that already succeeded this session (a stale snapshot
    // would otherwise overwrite the success with a false "already up to date" error).
    const prior = applyOutcome[id];
    if (prior && prior.kind !== "error") return;
    applyBusy = { ...applyBusy, [id]: true };
    const cleared = { ...applyOutcome };
    delete cleared[id]; // a retry starts clean
    applyOutcome = cleared;
    try {
      const res = await applyPluginUpdate(id);
      if (res.ok) {
        applyOutcome = {
          ...applyOutcome,
          [id]: {
            kind: res.result.restartRequired ? "restart" : "live",
            version: res.result.updatedTo,
          },
        };
        onpluginapplied?.(res.result.status);
        await loadInstalled(); // on-disk versions changed
      } else {
        applyOutcome = {
          ...applyOutcome,
          [id]: { kind: "error", msg: applyErrMessage(res.error), detail: res.detail },
        };
      }
    } finally {
      applyBusy = { ...applyBusy, [id]: false };
    }
  }

  /** Card-shaped update props: non-null when there is a badge to show OR an apply
   *  outcome to keep visible after the badge is gone. */
  function cardUpdate(
    id: string,
  ): { latest: string | null; applying: boolean; outcome: ApplyOutcome | null } | null {
    const u = availableUpdate(id);
    const outcome = applyOutcome[id] ?? null;
    if (!u && !outcome) return null;
    return { latest: u?.latestVersion ?? null, applying: !!applyBusy[id], outcome };
  }

  // A restart is owed to UNLOAD a plugin whose folder is gone (`removed`) — that can't be
  // done in-process — or to finish an in-place update of a plugin that was already running.
  // A `pending` (installed-not-loaded) plugin no longer needs one — the Activate button
  // loads it live — so it must not raise the restart banner.
  const pendingRestart = $derived(
    rows.some((r) => r.kind === "removed") ||
      Object.values(applyOutcome).some((o) => o.kind === "restart"),
  );

  const rowKey = (row: Row): string =>
    row.kind === "loaded" || row.kind === "removed"
      ? `id:${row.info.id}`
      : `folder:${row.inst.folder}`;

  function stateLabel(kind: "pending" | "disabled" | "broken"): string {
    if (kind === "broken") return m.plugins_state_broken();
    if (kind === "disabled") return m.plugins_state_disabled();
    return m.plugins_state_pending();
  }

  /** Map a stable server error CODE to a human message (never render the raw code). */
  function errorMessage(code: string): string {
    switch (code) {
      case "url_not_https":
      case "url_not_github":
        return m.plugins_err_url_not_github();
      case "url_has_credentials":
        return m.plugins_err_url_credentials();
      case "invalid_url":
      case "url_not_repo":
        return m.plugins_err_url_invalid();
      case "folder_exists":
        return m.plugins_err_folder_exists();
      case "invalid_manifest":
        return m.plugins_err_manifest();
      case "disabled":
        return m.plugins_err_disabled();
      case "api_version_mismatch":
        return m.plugins_err_api_version();
      case "id_collision":
      case "id_reserved":
        return m.plugins_err_id_taken();
      case "clonerepo_failed_timeout":
        return m.plugins_err_clone_timeout();
      case "clonerepo_failed_auth":
        return m.plugins_err_clone_auth();
      case "clonerepo_failed_url":
      case "clonerepo_failed_exists":
        return m.plugins_err_clone_url();
      default:
        return m.plugins_err_generic();
    }
  }

  function openInstallConfirm() {
    const u = url.trim();
    if (!u || installing) return;
    actionError = null;
    confirm = { kind: "install", url: u };
  }

  function askUninstall(folder: string, name: string, loaded = false) {
    actionError = null;
    confirm = { kind: "uninstall", folder, name, loaded };
  }

  function onConfirm(c: Confirm) {
    if (c.kind === "install") runInstall(c.url);
    else runUninstall(c.folder);
  }

  function openRestart(autoStart: boolean) {
    restartAutoStart = autoStart;
    restartOpen = true;
  }

  async function runInstall(u: string) {
    installing = true;
    actionError = null;
    confirm = null;
    try {
      const res = await installPlugin(u);
      if (res.ok) {
        url = "";
        await loadInstalled();
      } else {
        actionError = errorMessage(res.error);
      }
    } finally {
      installing = false;
    }
  }

  async function runUninstall(folder: string) {
    busyFolder = folder;
    actionError = null;
    confirm = null;
    try {
      const res = await uninstallPlugin(folder);
      if (res.ok) await loadInstalled();
      else actionError = errorMessage(res.error);
    } finally {
      busyFolder = null;
    }
  }

  async function runUninstallAndRestart(folder: string) {
    busyFolder = folder;
    actionError = null;
    confirm = null;
    try {
      const res = await uninstallPlugin(folder);
      if (res.ok) {
        await loadInstalled();
        openRestart(true);
      } else {
        actionError = errorMessage(res.error);
      }
    } finally {
      busyFolder = null;
    }
  }

  /** Activate a pending plugin in-process (no restart). `busyFolder` guards a double-click.
   *  On success the plugin is now in the registry (health `ok` OR `errored`): re-seed the
   *  store via `onpluginschanged` so the row flips to a loaded card (which itself surfaces an
   *  errored health + lastError), then hint a restart when it loaded but failed to register. */
  async function runActivate(folder: string) {
    busyFolder = folder;
    actionError = null;
    try {
      const res = await activatePlugin(folder);
      if (!res.ok) {
        actionError = errorMessage(res.error);
        return;
      }
      onpluginschanged?.();
      await loadInstalled();
      if (res.plugin.health !== "ok") {
        actionError = m.plugins_activate_needs_restart({ name: res.plugin.name });
      }
    } finally {
      busyFolder = null;
    }
  }

  async function copyRestart() {
    try {
      await navigator.clipboard.writeText(RESTART_CMD);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      /* clipboard blocked — the command is visible to copy manually */
    }
  }

  // When focusId changes (from a gear-item panel action), scroll the matching card into
  // view and briefly apply a highlight flash. The card id lives in PluginLoadedCard.
  $effect(() => {
    if (!focusId) return;
    const el = document.getElementById(`plugin-card-${focusId}`);
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    el.classList.add("focus-flash");
    const t = setTimeout(() => el.classList.remove("focus-flash"), 1200);
    return () => clearTimeout(t);
  });
</script>

<div class="plugins">
  <p class="intro micro">{m.plugins_intro()}</p>

  <!-- Install-from-URL -->
  <div class="install">
    <p class="install-heading">{m.plugins_install_heading()}</p>
    <div class="install-row">
      <input
        class="url"
        type="url"
        inputmode="url"
        placeholder={m.plugins_install_placeholder()}
        bind:value={url}
        disabled={installing}
        onkeydown={(e) => {
          if (e.key === "Enter") openInstallConfirm();
        }}
      />
      <button
        type="button"
        class="gbtn primary"
        disabled={installing || url.trim() === ""}
        onclick={openInstallConfirm}
      >
        {installing ? m.common_loading() : m.plugins_install_button()}
      </button>
    </div>
    <p class="install-hint micro">{m.plugins_install_hint()}</p>
    {#if actionError}
      <p class="err micro" role="alert">{actionError}</p>
    {/if}
  </div>

  <!-- Manual update check — the badge/rows refresh via the plugin-update:status broadcast -->
  <div class="updrow">
    <span class="upd-meta micro">
      {#if lastChecked}{m.plugins_updates_last_checked({ time: lastChecked })}{/if}
    </span>
    {#if checkFailed}
      <span class="err micro" role="alert">{m.plugins_update_check_failed()}</span>
    {/if}
    <button type="button" class="gbtn check" disabled={checking} onclick={runCheck}>
      {#if checking}{m.plugins_checking_updates()}{:else}<HighlightText
          text={m.plugins_check_updates()}
          {query}
        />{/if}
    </button>
  </div>

  {#if pendingRestart}
    <div class="banner" role="status">
      <span class="banner-text">{m.plugins_restart_banner()}</span>
      <code class="cmd">{RESTART_CMD}</code>
      <button type="button" class="gbtn copy" onclick={copyRestart}>
        {copied ? m.plugins_copied() : m.plugins_copy()}
      </button>
      <button type="button" class="gbtn restart-now" onclick={() => (restartOpen = true)}>
        {m.restart_now()}
      </button>
    </div>
  {/if}

  {#if loading && installed.length === 0}
    <p class="empty micro">{m.common_loading()}</p>
  {:else if rows.length === 0}
    <p class="empty micro">{m.plugins_empty()}</p>
  {/if}

  {#each rows as row (rowKey(row))}
    {#if row.kind === "loaded"}
      {@const rowId = row.info.id}
      <PluginLoadedCard
        plugin={row.info}
        folder={row.folder}
        busy={busyFolder === row.folder}
        onuninstall={(folder, name) => askUninstall(folder, name, true)}
        update={cardUpdate(rowId)}
        onupdate={() => runUpdate(rowId)}
      />
    {:else if row.kind === "removed"}
      <div class="row minimal">
        <span class="dot muted" aria-hidden="true"></span>
        <span class="name">{row.info.name}</span>
        <span class="ver micro">v{row.info.version}</span>
        <span class="state micro">{m.plugins_state_removed()}</span>
      </div>
    {:else}
      {@const upd = row.kind === "broken" ? null : cardUpdate(row.inst.id)}
      <div class="row minimal">
        <span class="dot muted" aria-hidden="true"></span>
        <span class="name">{row.inst.name}</span>
        {#if row.kind !== "broken" && row.inst.version}
          <span class="ver micro">v{row.inst.version}</span>
        {/if}
        <span class="state micro" class:broken={row.kind === "broken"}>{stateLabel(row.kind)}</span>
        {#if upd?.latest}
          {@const updId = row.inst.id}
          <span class="upd-badge micro">{m.pluginupdate_state_update({ latest: upd.latest })}</span>
          <button
            type="button"
            class="gbtn upd"
            disabled={upd.applying}
            onclick={() => runUpdate(updId)}
          >
            {upd.applying ? m.pluginupdate_applying() : m.pluginupdate_apply()}
          </button>
        {/if}
        {#if row.kind === "pending"}
          <button
            type="button"
            class="gbtn activate"
            disabled={busyFolder === row.inst.folder}
            onclick={() => runActivate(row.inst.folder)}
          >
            {busyFolder === row.inst.folder ? m.plugins_activating() : m.plugins_activate()}
          </button>
        {/if}
        {#if row.inst.repository}
          <a
            class="plugin-repo-link"
            href={row.inst.repository}
            target="_blank"
            rel="external noreferrer noopener"
          >
            <span aria-hidden="true">↗</span>
            <span>{m.plugins_repo()}</span>
          </a>
        {/if}
        <button
          type="button"
          class="gbtn del"
          disabled={busyFolder === row.inst.folder}
          onclick={() => askUninstall(row.inst.folder, row.inst.name, false)}
        >
          {m.plugins_uninstall()}
        </button>
        {#if upd?.outcome}
          {@const o = upd.outcome}
          <div class="upd-line">
            {#if o.kind === "error"}
              <p class="upd-outcome error micro" role="alert">{o.msg}</p>
              {#if o.detail}
                <p class="upd-detail micro">{o.detail}</p>
              {/if}
            {:else if o.kind === "restart"}
              <p class="upd-outcome micro">
                {m.pluginupdate_applied_restart({ version: o.version })}
              </p>
            {:else}
              <p class="upd-outcome live micro">
                {m.pluginupdate_applied_live({ version: o.version })}
              </p>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  {/each}
</div>

{#if confirm}
  <PluginConfirmDialog
    {confirm}
    onconfirm={onConfirm}
    onconfirmrestart={(c) => runUninstallAndRestart(c.folder)}
    oncancel={() => (confirm = null)}
  />
{/if}

{#if restartOpen}
  <RestartShepherdDialog
    shepherdOnly={restartAutoStart}
    autoStart={restartAutoStart}
    onclose={() => {
      restartOpen = false;
      restartAutoStart = false;
    }}
  />
{/if}

<style>
  .plugins {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .intro {
    color: var(--color-muted);
    margin: 0 0 4px;
  }

  /* Install section */
  .install {
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .install-heading {
    margin: 0;
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--color-ink);
  }
  .install-row {
    display: flex;
    gap: 8px;
  }
  .url {
    flex: 1;
    min-width: 0;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    color: var(--color-ink);
    padding: 8px 10px;
    font: inherit;
    font-size: var(--fs-base);
  }
  .url:focus-visible {
    outline: none;
    border-color: var(--color-amber);
  }
  .install-hint {
    color: var(--color-muted);
    margin: 0;
  }

  /* Base gear button recipe (from /design-system). */
  .gbtn {
    border: 1px solid var(--color-line-bright);
    background: transparent;
    color: var(--color-ink);
    padding: 8px 12px;
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    cursor: pointer;
    white-space: nowrap;
    flex: none;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  :global(.plugin-repo-link) {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.06em;
    text-decoration: none;
    white-space: nowrap;
  }
  :global(.plugin-repo-link:hover) {
    color: var(--color-amber);
  }
  :global(.plugin-repo-link:focus-visible) {
    outline: none;
    box-shadow: inset 0 -1px 0 var(--color-amber);
  }
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn.del,
  .gbtn.copy,
  .gbtn.restart-now,
  .gbtn.activate,
  .gbtn.check,
  .gbtn.upd {
    font-size: var(--fs-micro);
    padding: 5px 9px;
  }
  /* Activate / Update / Restart are the row's primary action — amber accent like the install button. */
  .gbtn.activate,
  .gbtn.upd,
  .gbtn.restart-now {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  /* Manual update-check row */
  .updrow {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .upd-meta {
    color: var(--color-muted);
    margin-right: auto;
  }
  .updrow .err {
    margin: 0;
  }

  /* In-row update state (badge + persisted apply outcome) */
  .upd-badge {
    font-size: var(--fs-micro);
    padding: 2px 8px;
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    white-space: nowrap;
    flex: none;
  }
  .upd-line {
    flex-basis: 100%;
  }
  .upd-outcome {
    margin: 4px 0 0;
    color: var(--color-amber);
  }
  .upd-outcome.live {
    color: var(--color-green, var(--color-blue));
  }
  .upd-outcome.error {
    color: var(--color-red);
    word-break: break-word;
  }
  .upd-detail {
    margin: 2px 0 0;
    color: var(--color-muted);
    font-family: var(--font-mono, monospace);
    word-break: break-word;
  }

  /* Restart-owed banner */
  .banner {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    border: 1px solid var(--color-amber);
    background: var(--wash-warn, var(--color-inset));
    padding: 8px 10px;
  }
  .banner-text {
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  .cmd {
    font-family: var(--font-mono, monospace);
    font-size: var(--fs-micro);
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    padding: 3px 6px;
    color: var(--color-ink);
  }
  .banner .copy {
    margin-left: auto;
  }

  /* Minimal (non-loaded) rows — wrap so the update outcome can span a full line */
  .row.minimal {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    padding: 8px 10px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
  }
  .dot.muted {
    background: var(--color-muted);
  }
  .name {
    font-size: var(--fs-base);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ver {
    color: var(--color-muted);
  }
  .state {
    margin-left: auto;
    color: var(--color-muted);
  }
  .state.broken {
    color: var(--color-red);
  }
  .err {
    color: var(--color-red);
    margin: 6px 0 0;
    word-break: break-word;
  }
  .empty {
    color: var(--color-muted);
    margin: 6px 0 0;
  }

  /* ≥44px tap targets for the plugin action controls (install/activate/check/
     uninstall buttons + the install-URL field) on touch, without inflating the
     desktop rows. */
  @media (pointer: coarse) {
    .gbtn,
    .install input {
      min-height: 44px;
    }
  }
</style>
