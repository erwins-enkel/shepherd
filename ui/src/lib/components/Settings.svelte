<script lang="ts">
  import { onMount, untrack } from "svelte";
  import {
    getSettings,
    putDefaultModel,
    putDefaultCodexModel,
    putDefaultAgentProvider,
    putFableAvailable,
    putReducedPushMode,
  } from "$lib/api";
  import type {
    AgentProvider,
    HerdrUpdateStatus,
    CodexUpdateStatus,
    PluginUpdatesStatus,
    DiagnosticCheck,
    PluginInfo,
    Settings,
  } from "$lib/types";
  import {
    SETTINGS_SECTION_IDS,
    SECTION_GLYPHS,
    sectionSearchRows,
    matchCount,
    type SettingsSectionId,
    type SettingsSectionNav,
  } from "$lib/settings-search";
  import SettingsShell from "$lib/components/settings/SettingsShell.svelte";
  import SettingsWorkspacePanel from "$lib/components/settings/SettingsWorkspacePanel.svelte";
  import SettingsCodingCliPanel from "$lib/components/settings/SettingsCodingCliPanel.svelte";
  import SettingsSessionPanel from "$lib/components/settings/SettingsSessionPanel.svelte";
  import SettingsDevicePanel from "$lib/components/settings/SettingsDevicePanel.svelte";
  import SettingsDiagnosePanel from "$lib/components/settings/SettingsDiagnosePanel.svelte";
  import SettingsPluginsPanel from "$lib/components/settings/SettingsPluginsPanel.svelte";
  import { dialog } from "$lib/a11yDialog";
  import { openFeedback } from "$lib/feedback-dialog.svelte";
  import type { FeedbackKind } from "$lib/feedback-link";
  import { theme } from "$lib/theme.svelte";
  import { version } from "$lib/build-info";
  import { toasts } from "$lib/toasts.svelte";
  import { m } from "$lib/paraglide/messages";

  // Settings dialog — "Sidebar Cockpit" (design handoff 5a/5b): a summoned
  // 780px dialog whose nav rail + content pane replace the old wrapping tab
  // strip; on mobile a full-screen section list with drill-in detail pages.
  // This component owns the modal chrome, the single getSettings() load, and
  // the cross-section state (provider/model trio, fable, reduced-push); the
  // section panels own their section-scoped state, seeded from the payload.
  // The HERDR/codex/plugin update CTAs stay pinned above the body as alerts.
  let {
    onclose,
    onsaved,
    herdrUpdate = null,
    onherdrupdate,
    codexUpdate = null,
    oncodexupdate,
    pluginUpdates = null,
    onpluginupdates,
    onpluginapplied,
    onwhatsnew,
    initialTab = "workspace",
    initialMobileView = "list",
    initialDiagnostics = null,
    plugins = [],
    onpluginschanged,
    focusPluginId = null,
    focusSteerId = null,
    connected = false,
  }: {
    onclose?: () => void;
    onsaved?: (root: string) => void;
    herdrUpdate?: HerdrUpdateStatus | null;
    onherdrupdate?: () => void;
    codexUpdate?: CodexUpdateStatus | null;
    oncodexupdate?: () => void;
    pluginUpdates?: PluginUpdatesStatus | null;
    onpluginupdates?: () => void;
    /** After an inline apply on the Plugins section: adopt the recomputed update
     *  snapshot (same contract as PluginUpdatesModal's `onapplied`). */
    onpluginapplied?: (status: PluginUpdatesStatus) => void;
    onwhatsnew?: () => void;
    initialTab?: SettingsSectionId;
    /** Mobile entry route: "list" shows the section list (plain gear open);
     *  "detail" drills straight into initialTab (deep links — diagnostics dot,
     *  plugin focus, steer focus, add-repo). Desktop ignores it. */
    initialMobileView?: "list" | "detail";
    /** Live diagnostics checks from the store; the diagnose panel re-fetches
     *  on open if absent. Also drives the rail dot / mobile ISSUE chip. */
    initialDiagnostics?: DiagnosticCheck[] | null;
    /** Loaded server-side plugins (issue #1124). */
    plugins?: PluginInfo[];
    /** Called after a plugin is activated in-process so the parent can refresh
     *  `store.plugins`. */
    onpluginschanged?: () => void;
    /** Plugin id to scroll into view + highlight on open. */
    focusPluginId?: string | null;
    /** Steer id to expand + focus in the steers editor on open. */
    focusSteerId?: string | null;
    /** WS liveness for the rail footer's ● live/offline dot. */
    connected?: boolean;
  } = $props();

  // initialTab/initialMobileView seed the starting route; the user then freely
  // navigates, so the props are read once (untrack silences the warning).
  let active = $state<SettingsSectionId>(untrack(() => initialTab));
  let query = $state("");
  let mobileList = $state(untrack(() => initialMobileView === "list"));

  // Below the full-screen breakpoint the desktop tablist doesn't exist, so each
  // panel is a labelled region there instead of an orphaned tabpanel. Applied
  // imperatively so role and tabindex always agree (tabindex is only valid on
  // the interactive tabpanel) without tripping the a11y linter.
  const NARROW_QUERY = "(max-width: 768px)";
  let isNarrow = $state(
    typeof matchMedia !== "undefined" ? matchMedia(NARROW_QUERY).matches : false,
  );
  onMount(() => {
    if (typeof matchMedia === "undefined") return;
    const mq = matchMedia(NARROW_QUERY);
    const onChange = () => (isNarrow = mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  });
  function panelShape(node: HTMLElement, narrow: boolean) {
    const apply = (n: boolean) => {
      node.setAttribute("role", n ? "region" : "tabpanel");
      if (n) node.removeAttribute("tabindex");
      else node.setAttribute("tabindex", "0");
    };
    apply(narrow);
    return { update: apply };
  }

  // On a phone the HERDR badge folds into the gear; its update flow lands here.
  const herdrUpdateAvailable = $derived(!!herdrUpdate && herdrUpdate.updateAvailable);
  const codexUpdateAvailable = $derived(!!codexUpdate && codexUpdate.updateAvailable);
  const pluginUpdateAvailable = $derived(!!pluginUpdates && pluginUpdates.updateAvailable);
  const pluginUpdateCount = $derived(
    pluginUpdates?.plugins.filter((p) => p.state === "update-available").length ?? 0,
  );
  // The active update CTAs (herdr / codex / plugin), assembled in the script so
  // the template renders them with one loop instead of three near-identical `{#if}`s.
  type UpdateCta = { key: string; cls: string; label: string; detail: string; onclick: () => void };
  const updateCtas = $derived(
    [
      herdrUpdateAvailable && {
        key: "herdr",
        cls: "",
        label: m.settings_herdr_update_label(),
        detail: m.topbar_herdr_update_title({
          current: herdrUpdate!.current ?? "?",
          latest: herdrUpdate!.latest ?? "?",
        }),
        onclick: () => onherdrupdate?.(),
      },
      codexUpdateAvailable && {
        key: "codex",
        cls: "codex-cta",
        label: m.settings_codex_update_label(),
        detail: m.topbar_codex_update_title({
          current: codexUpdate!.current ?? "?",
          latest: codexUpdate!.latest ?? "?",
        }),
        onclick: () => oncodexupdate?.(),
      },
      pluginUpdateAvailable && {
        key: "plugin",
        cls: "codex-cta",
        label: m.settings_plugin_update_label(),
        detail: m.settings_plugin_update_count({ count: pluginUpdateCount }),
        onclick: () => onpluginupdates?.(),
      },
    ].filter(Boolean) as UpdateCta[],
  );

  // ── Cross-section state (everything else lives in the section panels) ─────
  let payload = $state<Settings | null>(null);
  let defaultModel = $state("auto"); // raw default-model setting (auto|default|<alias>)
  let defaultModelSaved = "auto";
  let defaultModelBusy = $state(false);
  let defaultCodexModel = $state("gpt-5.5");
  let defaultCodexModelSaved = "gpt-5.5";
  let defaultCodexModelBusy = $state(false);
  let defaultAgentProvider = $state<AgentProvider>("claude");
  let defaultAgentProviderSaved: AgentProvider = "claude";
  let defaultAgentProviderBusy = $state(false);
  // Fable availability — shared by Coding CLI guidance and the Session toggle.
  let fableAvailable = $state(true);
  let fableAvailableBusy = $state(false);
  // Reduced-notifications mode — surfaced in the Device panel.
  let reducedPushMode = $state(false);
  let reducedPushBusy = $state(false);
  // Repo root, resolved by the single getSettings() below and handed to the
  // workspace panel as props so it never re-fetches.
  let repoRoot = $state<string | null>(null);
  let repoRootDisplay = $state<string | null>(null);
  let settingsLoaded = $state(false);

  async function saveDefaultModel() {
    if (defaultModelBusy) return;
    defaultModelBusy = true;
    try {
      const r = await putDefaultModel(defaultModel);
      defaultModel = r.defaultModel;
      defaultModelSaved = r.defaultModel;
    } catch {
      // revert to the last server-confirmed value; surface the failure as a
      // 12s, deduped alert so the no-op never looks like a save.
      defaultModel = defaultModelSaved;
      toasts.info(m.settings_default_model_save_failed(), {
        key: "default-model",
        alert: true,
      });
    } finally {
      defaultModelBusy = false;
    }
  }

  async function saveDefaultCodexModel() {
    if (defaultCodexModelBusy) return;
    defaultCodexModelBusy = true;
    try {
      const r = await putDefaultCodexModel(defaultCodexModel);
      defaultCodexModel = r.defaultCodexModel;
      defaultCodexModelSaved = r.defaultCodexModel;
    } catch {
      defaultCodexModel = defaultCodexModelSaved;
      toasts.info(m.settings_default_codex_model_save_failed(), {
        key: "default-codex-model",
        alert: true,
      });
    } finally {
      defaultCodexModelBusy = false;
    }
  }

  async function saveDefaultAgentProvider() {
    if (defaultAgentProviderBusy) return;
    defaultAgentProviderBusy = true;
    try {
      const r = await putDefaultAgentProvider(defaultAgentProvider);
      defaultAgentProvider = r.defaultAgentProvider;
      defaultAgentProviderSaved = r.defaultAgentProvider;
    } catch {
      defaultAgentProvider = defaultAgentProviderSaved;
      toasts.info(m.settings_default_agent_provider_save_failed(), {
        key: "default-agent-provider",
        alert: true,
      });
    } finally {
      defaultAgentProviderBusy = false;
    }
  }

  async function toggleFableAvailable() {
    if (fableAvailableBusy) return;
    fableAvailableBusy = true;
    const next = !fableAvailable;
    try {
      const r = await putFableAvailable(next);
      fableAvailable = r.fableAvailable;
    } catch {
      toasts.info(m.settings_fable_available_save_failed(), {
        key: "fable-available",
        alert: true,
      });
    } finally {
      fableAvailableBusy = false;
    }
  }

  async function toggleReducedPush() {
    if (reducedPushBusy) return;
    reducedPushBusy = true;
    try {
      const r = await putReducedPushMode(!reducedPushMode);
      reducedPushMode = r.reducedPushMode;
    } catch {
      toasts.info(m.settings_reduced_push_save_failed(), {
        key: "reduced-push-mode",
        alert: true,
      });
    } finally {
      reducedPushBusy = false;
    }
  }

  onMount(async () => {
    try {
      const s = await getSettings();
      payload = s; // the section panels seed their own state from this
      defaultModel = s.defaultModel ?? "auto";
      defaultModelSaved = defaultModel;
      defaultCodexModel = s.defaultCodexModel ?? "gpt-5.5";
      defaultCodexModelSaved = defaultCodexModel;
      defaultAgentProvider = s.defaultAgentProvider ?? "claude";
      defaultAgentProviderSaved = s.defaultAgentProvider ?? "claude";
      fableAvailable = s.fableAvailable;
      reducedPushMode = s.reducedPushMode;
      repoRoot = s.repoRoot;
      repoRootDisplay = s.repoRootDisplay;
    } catch {
      // settings load failed — panels keep their defaults; the workspace panel
      // falls back to browsing the default dir (repoRoot stays null)
    } finally {
      settingsLoaded = true;
    }
  });

  // ── Nav metadata for the shell ────────────────────────────────────────────
  function sectionLabel(id: SettingsSectionId): string {
    switch (id) {
      case "workspace":
        return m.settings_tab_workspace();
      case "codingAgents":
        return m.settings_tab_coding_agents();
      case "plugins":
        return m.settings_tab_plugins();
      case "session":
        return m.settings_tab_session();
      case "device":
        return m.settings_tab_device();
      case "diagnose":
        return m.settings_tab_diagnose();
    }
  }
  // Current-value summaries for the mobile section list (5b): repo root, the
  // default CLI, plugin count, theme · contrast. Lowercased to the handoff's
  // instrument look ("dark · AAA") except values that are proper names.
  const themeSummary = $derived.by(() => {
    const base =
      theme.pref === "system"
        ? m.theme_system()
        : theme.pref === "light"
          ? m.theme_light()
          : m.theme_dark();
    return (theme.contrast ? `${base} · AAA` : base).toLowerCase();
  });
  function sectionSummary(id: SettingsSectionId): string {
    switch (id) {
      case "workspace":
        return repoRootDisplay ?? "";
      case "codingAgents":
        return defaultAgentProvider === "codex" ? m.settings_cli_codex() : m.settings_cli_claude();
      case "plugins":
        return m.settings_plugins_installed_summary({ count: plugins.length });
      case "device":
        return themeSummary;
      default:
        return "";
    }
  }
  // Diagnostics issues drive the rail's red dot / the mobile ISSUE chip —
  // derived from the live checks (there is no server-side count).
  const diagCount = $derived(
    (initialDiagnostics ?? []).filter((c) => c.state === "error" || c.state === "warning").length,
  );
  const searchRows = $derived(sectionSearchRows({ provider: defaultAgentProvider }));
  const sections = $derived<SettingsSectionNav[]>(
    SETTINGS_SECTION_IDS.map((id) => ({
      id,
      glyph: SECTION_GLYPHS[id],
      label: sectionLabel(id),
      summary: sectionSummary(id),
      matchCount: matchCount(searchRows[id], query),
      alertCount: id === "diagnose" ? diagCount : 0,
    })),
  );
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose?.();
  }}
>
  <div
    class="card"
    role="dialog"
    aria-modal="true"
    aria-label={m.settings_title()}
    use:dialog={{ onclose: () => onclose?.() }}
  >
    <SettingsShell
      {sections}
      bind:active
      bind:query
      bind:mobileList
      {version}
      live={connected}
      {onclose}
    >
      {#snippet banner()}
        <!-- herdr / codex / plugin update CTAs share one row shape; built as a
             list in the script so the template carries a single loop. -->
        {#each updateCtas as cta (cta.key)}
          <button type="button" class="herdr-cta {cta.cls}" onclick={cta.onclick}>
            <span class="hc-dot" aria-hidden="true">▲</span>
            <span class="hc-text">
              <span class="hc-label">{cta.label}</span>
              <span class="hc-ver">{cta.detail}</span>
            </span>
            <span class="hc-chev" aria-hidden="true">›</span>
          </button>
        {/each}
      {/snippet}

      <!-- All six panels stay mounted and toggle via `hidden`: every
           settings-panel-* id resolves for the rail's aria-controls, and the
           steers editor keeps any in-progress draft across section switches
           instead of remounting and resyncing from the store. -->
      <div
        class="panel"
        use:panelShape={isNarrow}
        id="settings-panel-workspace"
        aria-label={m.settings_tab_workspace()}
        hidden={active !== "workspace"}
      >
        <SettingsWorkspacePanel {repoRoot} {repoRootDisplay} {settingsLoaded} {onsaved} {onclose} />
      </div>

      <div
        class="panel"
        use:panelShape={isNarrow}
        id="settings-panel-codingAgents"
        aria-label={m.settings_tab_coding_agents()}
        hidden={active !== "codingAgents"}
      >
        <SettingsCodingCliPanel
          {payload}
          {query}
          bind:defaultAgentProvider
          bind:defaultModel
          bind:defaultCodexModel
          {defaultAgentProviderBusy}
          {defaultModelBusy}
          {defaultCodexModelBusy}
          {fableAvailable}
          onProviderChange={saveDefaultAgentProvider}
          onClaudeModelChange={saveDefaultModel}
          onCodexModelChange={saveDefaultCodexModel}
        />
      </div>

      <div
        class="panel"
        use:panelShape={isNarrow}
        id="settings-panel-plugins"
        aria-label={m.settings_tab_plugins()}
        hidden={active !== "plugins"}
      >
        <SettingsPluginsPanel
          {plugins}
          {onpluginschanged}
          focusId={focusPluginId}
          updates={pluginUpdates}
          {onpluginapplied}
        />
      </div>

      <div
        class="panel"
        use:panelShape={isNarrow}
        id="settings-panel-session"
        aria-label={m.settings_tab_session()}
        hidden={active !== "session"}
      >
        <SettingsSessionPanel
          {payload}
          {query}
          {fableAvailable}
          {fableAvailableBusy}
          onToggleFable={toggleFableAvailable}
          {focusSteerId}
        />
      </div>

      <div
        class="panel"
        use:panelShape={isNarrow}
        id="settings-panel-device"
        aria-label={m.settings_tab_device()}
        hidden={active !== "device"}
      >
        <SettingsDevicePanel
          {onwhatsnew}
          {reducedPushMode}
          {reducedPushBusy}
          onToggleReducedPush={toggleReducedPush}
          onfeedback={(kind: FeedbackKind) => {
            onclose?.();
            openFeedback(kind);
          }}
        />
      </div>

      <div
        class="panel"
        use:panelShape={isNarrow}
        id="settings-panel-diagnose"
        aria-label={m.settings_tab_diagnose()}
        hidden={active !== "diagnose"}
      >
        <SettingsDiagnosePanel {initialDiagnostics} onherdrdowngrade={() => onherdrupdate?.()} />
      </div>
    </SettingsShell>
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
  /* Square-cornered summoned dialog: --shadow-popover is earned (it floats
     over the app), no corner brackets — per the 5a handoff. Fixed height so
     the shell stays stable across section switches; the pane body scrolls. */
  .card {
    position: relative;
    width: min(780px, 92vw);
    height: min(680px, 86vh);
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    box-shadow: var(--shadow-popover);
    display: flex;
    flex-direction: column;
    overflow: hidden;
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
    margin: 8px 14px 0;
    padding: 10px 12px;
    cursor: pointer;
    font: inherit;
    color: var(--color-ink-bright);
    flex-shrink: 0;
  }
  .herdr-cta .hc-dot {
    color: var(--color-green);
    font-size: var(--fs-micro);
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
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .herdr-cta .hc-ver {
    color: var(--color-muted);
    font-size: var(--fs-base);
  }
  .herdr-cta .hc-chev {
    color: var(--color-green);
    font-size: var(--fs-xl);
    line-height: 1;
  }
  /* Codex CLI update entry point — blue (informational), matching its badge. */
  .codex-cta {
    border-color: var(--color-blue);
    background: color-mix(in srgb, var(--color-blue) 12%, transparent);
  }
  .codex-cta .hc-dot,
  .codex-cta .hc-label,
  .codex-cta .hc-chev {
    color: var(--color-blue);
  }
  /* `:not([hidden])` carries `display` so the `hidden` attribute on inactive
     panels still collapses them. */
  .panel:not([hidden]) {
    display: flex;
  }
  .panel {
    flex-direction: column;
  }
  /* Keyboard focus on the tabpanel gets a quiet inset hairline (tabindex=0 stop). */
  .panel:focus-visible {
    outline: 1px solid var(--color-line-bright);
    outline-offset: -2px;
  }

  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
    }
    .card {
      width: 100%;
      max-width: none;
      height: 100dvh;
      max-height: none;
      border: 0;
      box-shadow: none;
    }
  }
</style>
