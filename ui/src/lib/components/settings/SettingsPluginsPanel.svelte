<script lang="ts">
  import { onMount } from "svelte";
  import { m } from "$lib/paraglide/messages";
  import { getInstalledPlugins, installPlugin, uninstallPlugin, activatePlugin } from "$lib/api";
  import type { PluginInfo, InstalledPlugin } from "$lib/types";
  import PluginLoadedCard from "./PluginLoadedCard.svelte";
  import PluginConfirmDialog from "./PluginConfirmDialog.svelte";

  let {
    plugins = [],
    onpluginschanged,
    focusId = null,
  }: {
    plugins?: PluginInfo[];
    /** Called after an in-process activation so the parent can re-seed `store.plugins`
     *  (a freshly-loaded id must land in the store for the row to flip to a loaded card
     *  and for its gear/UI pushes to stop no-opping). */
    onpluginschanged?: () => void;
    focusId?: string | null;
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
    { kind: "install"; url: string } | { kind: "uninstall"; folder: string; name: string };
  let confirm = $state<Confirm | null>(null);

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

  // A restart is owed only to UNLOAD a plugin whose folder is gone (`removed`): that can't be
  // done in-process. A `pending` (installed-not-loaded) plugin no longer needs one — the
  // Activate button loads it live — so it must not raise the restart banner.
  const pendingRestart = $derived(rows.some((r) => r.kind === "removed"));

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

  function askUninstall(folder: string, name: string) {
    actionError = null;
    confirm = { kind: "uninstall", folder, name };
  }

  function onConfirm(c: Confirm) {
    if (c.kind === "install") runInstall(c.url);
    else runUninstall(c.folder);
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

  {#if pendingRestart}
    <div class="banner" role="status">
      <span class="banner-text">{m.plugins_restart_banner()}</span>
      <code class="cmd">{RESTART_CMD}</code>
      <button type="button" class="gbtn copy" onclick={copyRestart}>
        {copied ? m.plugins_copied() : m.plugins_copy()}
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
      <PluginLoadedCard
        plugin={row.info}
        folder={row.folder}
        busy={busyFolder === row.folder}
        onuninstall={askUninstall}
      />
    {:else if row.kind === "removed"}
      <div class="row minimal">
        <span class="dot muted" aria-hidden="true"></span>
        <span class="name">{row.info.name}</span>
        <span class="ver micro">v{row.info.version}</span>
        <span class="state micro">{m.plugins_state_removed()}</span>
      </div>
    {:else}
      <div class="row minimal">
        <span class="dot muted" aria-hidden="true"></span>
        <span class="name">{row.inst.name}</span>
        {#if row.kind !== "broken" && row.inst.version}
          <span class="ver micro">v{row.inst.version}</span>
        {/if}
        <span class="state micro" class:broken={row.kind === "broken"}>{stateLabel(row.kind)}</span>
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
        <button
          type="button"
          class="gbtn del"
          disabled={busyFolder === row.inst.folder}
          onclick={() => askUninstall(row.inst.folder, row.inst.name)}
        >
          {m.plugins_uninstall()}
        </button>
      </div>
    {/if}
  {/each}
</div>

{#if confirm}
  <PluginConfirmDialog {confirm} onconfirm={onConfirm} oncancel={() => (confirm = null)} />
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
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn.del,
  .gbtn.copy,
  .gbtn.activate {
    font-size: var(--fs-micro);
    padding: 5px 9px;
  }
  /* Activate is the row's primary action — amber accent like the install button. */
  .gbtn.activate {
    border-color: var(--color-amber);
    color: var(--color-amber);
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

  /* Minimal (non-loaded) rows */
  .row.minimal {
    display: flex;
    align-items: center;
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
</style>
