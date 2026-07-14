<script lang="ts">
  import { onMount, untrack } from "svelte";
  import {
    getSettings,
    putRemoteControl,
    putSessionHousekeeping,
    putPrReviewCyclesCap,
    putPlanReviewCyclesCap,
    putDefaultModel,
    putDefaultCodexModel,
    putDefaultEffort,
    putOperatorLanguage,
    putRoleModel,
    putRoleEffort,
    putRoleCli,
    putDistillerIntervalDays,
    putDefaultAgentProvider,
    putUpnextSkipCliPicker,
    putAuthMode,
    putAnthropicApiKey,
    verifyApiKey,
    putExtraCreditsDrainCeiling,
    putUsageHoldEnabled,
    putUsageHoldPct,
    putUsageDowngradeEnabled,
    putUsageDowngradePct,
    putUsageDowngradeModel,
    putFableAvailable,
    putReducedPushMode,
    putTuiFullscreen,
    putTuiDisableMouse,
    putTelemetryConsent,
    logout,
  } from "$lib/api";
  import { verifyFailureMessage } from "$lib/verify-key";
  import { modelLabel } from "$lib/model-label";
  import { modelGuidanceAlias, modelOptionLabel } from "$lib/model-guidance";
  import {
    effortLabel,
    effortAvailableForProvider,
    providerEfforts,
    effortBelowHigh,
  } from "$lib/effort-guidance";
  import {
    AGENT_PROVIDERS,
    MODELS,
    EFFORTS,
    MODELS_BY_PROVIDER,
    type AgentProvider,
    type HerdrUpdateStatus,
    type CodexUpdateStatus,
    type PluginUpdatesStatus,
    type DiagnosticCheck,
    type PluginInfo,
  } from "$lib/types";
  import SteersEditor from "$lib/components/SteersEditor.svelte";
  import SettingsWorkspacePanel from "$lib/components/settings/SettingsWorkspacePanel.svelte";
  import SettingsDevicePanel from "$lib/components/settings/SettingsDevicePanel.svelte";
  import SettingsDiagnosePanel from "$lib/components/settings/SettingsDiagnosePanel.svelte";
  import SettingsPluginsPanel from "$lib/components/settings/SettingsPluginsPanel.svelte";
  import SettingsDefaultEnvironment from "$lib/components/settings/SettingsDefaultEnvironment.svelte";
  import RestartShepherdDialog from "$lib/components/RestartShepherdDialog.svelte";
  import ModelGuidance from "$lib/components/ModelGuidance.svelte";
  import { dialog } from "$lib/a11yDialog";
  import { openFeedback } from "$lib/feedback-dialog.svelte";
  import type { FeedbackKind } from "$lib/feedback-link";
  import { toasts } from "$lib/toasts.svelte";
  import { m } from "$lib/paraglide/messages";

  // Settings group into focused jobs so the modal never outgrows the viewport:
  // WORKSPACE (which repo root), CODING CLIS (provider/auth/model), PLUGINS
  // (installed plugins), SESSION (runtime defaults + review gates), DEVICE (this
  // browser's notifications + theme), DIAGNOSTICS (troubleshooting, last). The
  // HERDR-update CTA is an alert, not a section, so it stays pinned above the tabs.
  // Plugins (issue #1124) sits high in the order. The tab is ALWAYS shown now that it
  // hosts the install-from-URL manager (a fresh clone with zero plugins still needs the
  // entry point to install its first one).
  const ALL_TABS = [
    { id: "workspace", label: m.settings_tab_workspace },
    { id: "codingAgents", label: m.settings_tab_coding_agents },
    { id: "plugins", label: m.settings_tab_plugins },
    { id: "session", label: m.settings_tab_session },
    { id: "device", label: m.settings_tab_device },
    { id: "diagnose", label: m.settings_tab_diagnose },
  ] as const;
  type TabId = (typeof ALL_TABS)[number]["id"];
  let tabEls = $state<HTMLButtonElement[]>([]);

  function onTabKey(e: KeyboardEvent, i: number) {
    const tabs = visibleTabs;
    let next: number;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
      next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    tab = tabs[next].id;
    tabEls[next]?.focus();
  }

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
    initialDiagnostics = null,
    plugins = [],
    onpluginschanged,
    focusPluginId = null,
    focusSteerId = null,
  }: {
    onclose?: () => void;
    onsaved?: (root: string) => void;
    herdrUpdate?: HerdrUpdateStatus | null;
    onherdrupdate?: () => void;
    codexUpdate?: CodexUpdateStatus | null;
    oncodexupdate?: () => void;
    pluginUpdates?: PluginUpdatesStatus | null;
    onpluginupdates?: () => void;
    /** After an inline apply on the Plugins tab: adopt the recomputed update snapshot
     *  (same contract as PluginUpdatesModal's `onapplied`). */
    onpluginapplied?: (status: PluginUpdatesStatus) => void;
    onwhatsnew?: () => void;
    initialTab?: TabId;
    /** Pre-seeded diagnostics checks from the store; loaded fresh on tab open if absent. */
    initialDiagnostics?: DiagnosticCheck[] | null;
    /** Loaded server-side plugins (issue #1124); empty → the Plugins tab is hidden. */
    plugins?: PluginInfo[];
    /** Called after a plugin is activated in-process so the parent can refresh `store.plugins`
     *  (a freshly-loaded id must be seeded into the store for its row to flip to a loaded card
     *  and for its gear/UI pushes to stop no-opping on an unknown id). */
    onpluginschanged?: () => void;
    /** Plugin id to scroll into view + highlight on open (from gear-item panel action). */
    focusPluginId?: string | null;
    /** Steer id to expand + focus in the steers editor on open (from a chip's right-click). */
    focusSteerId?: string | null;
  } = $props();

  // initialTab seeds the starting tab; the user then freely switches it, so we
  // only ever read the prop once (untrack silences the initial-value warning).
  let tab = $state<TabId>(untrack(() => initialTab));
  let steersEl = $state<HTMLDivElement | null>(null);

  // Every tab is always visible — the Plugins tab now hosts the install manager, so it must
  // render even with zero loaded plugins.
  const visibleTabs = ALL_TABS;

  // Below the card's full-screen breakpoint the tab strip is swapped for a dropdown:
  // the fixed tab set can't fit one row in the 520px card, and the full-screen mobile
  // card clips the overflow (the last tab would land off-screen). Mirrors theme.svelte.ts.
  const NARROW_QUERY = "(max-width: 768px)";
  let isNarrow = $state(
    typeof matchMedia !== "undefined" ? matchMedia(NARROW_QUERY).matches : false,
  );

  onMount(() => {
    // Skip the scroll-to-top when a specific steer is targeted — SteersEditor scrolls
    // that row into view itself, and a competing top-scroll would fight it.
    if (initialTab === "session" && !focusSteerId) {
      requestAnimationFrame(() => steersEl?.scrollIntoView({ behavior: "auto", block: "start" }));
    }
    if (typeof matchMedia === "undefined") return;
    const mq = matchMedia(NARROW_QUERY);
    const onChange = () => (isNarrow = mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  });

  // Keep each panel's role honest across the tablist↔dropdown swap: a focusable
  // tabpanel on desktop (a real tab in the strip owns it), a plain labelled region
  // on mobile where no tablist exists to own it (an orphaned tabpanel otherwise).
  // Applied imperatively so the role and the tabindex — only valid on the
  // interactive tabpanel — always agree without tripping the a11y linter.
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
  // Same fold-in for the Codex CLI update badge.
  const codexUpdateAvailable = $derived(!!codexUpdate && codexUpdate.updateAvailable);
  // Installed-plugin updates: a CTA to the informational plugin-update modal,
  // shown only when at least one plugin has a newer released version.
  const pluginUpdateAvailable = $derived(!!pluginUpdates && pluginUpdates.updateAvailable);
  const pluginUpdateCount = $derived(
    pluginUpdates?.plugins.filter((p) => p.state === "update-available").length ?? 0,
  );

  // The active update CTAs (herdr / codex / plugin), assembled in the script so the
  // template renders them with one loop instead of three near-identical `{#if}`s.
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

  let remoteControl = $state(false); // Claude Code Remote Control auto-start in sessions
  let rcBusy = $state(false);
  let restartOpen = $state(false); // the Restart-Shepherd confirm dialog
  let telemetryOn = $state(false);
  let telemetryAvailable = $state(false);
  let telemetryBusy = $state(false);
  let housekeeping = $state(true); // daily prune of old archived sessions (kill switch)
  let hkBusy = $state(false);
  let retentionDays = $state(30); // display-only, from the settings payload
  let retentionKeep = $state(250); // display-only, from the settings payload
  let prReviewCycles = $state(3); // global max PR-critic auto-address rounds (stepper value)
  let prReviewCyclesMin = $state(1); // bounds from the settings payload (drive min/max)
  let prReviewCyclesMax = $state(8);
  let prReviewCyclesSaved = 3; // last server-confirmed value, for revert on failure
  let prRcyBusy = $state(false);
  let planReviewCycles = $state(5); // global max plan-gate revise rounds (stepper value)
  let planReviewCyclesMin = $state(1); // bounds from the settings payload (drive min/max)
  let planReviewCyclesMax = $state(12);
  let planReviewCyclesSaved = 5; // last server-confirmed value, for revert on failure
  let planRcyBusy = $state(false);
  let defaultModel = $state("auto"); // raw default-model setting (auto|default|<alias>)
  let defaultModelSaved = "auto"; // last server-confirmed value, for revert on failure
  let defaultModelBusy = $state(false);
  let defaultCodexModel = $state("gpt-5.5");
  let defaultCodexModelSaved = "gpt-5.5";
  let defaultCodexModelBusy = $state(false);

  let defaultEffort = $state("default"); // raw default-effort setting ("default"|<tier>)
  let defaultEffortSaved = "default"; // last server-confirmed value, for revert on failure
  let defaultEffortBusy = $state(false);
  let operatorLanguage = $state("en"); // language spawned agents use to talk to the operator
  let operatorLanguageSaved = "en"; // last server-confirmed, for revert on failure
  let operatorLanguageBusy = $state(false);
  let defaultAgentProvider = $state<AgentProvider>("claude");
  let defaultAgentProviderSaved: AgentProvider = "claude";
  let defaultAgentProviderBusy = $state(false);
  let distillerIntervalDays = $state(1);
  let distillerIntervalDaysSaved = 1;
  let distillerIntervalDaysMin = $state(1);
  let distillerIntervalDaysMax = $state(14);
  let distillerIntervalBusy = $state(false);
  // Per-role ENVIRONMENT overrides (plan reviewer, PR critic, recap, doc-agent, namer, autopilot).
  // Each role is a PAIR: a CLI (`<role>Cli` ∈ "inherit"|"claude"|"codex"; "inherit" follows the
  // global provider+model) and a model (`<role>Model` ∈ "default"|<alias for that CLI>). Seeds
  // mirror the server defaults so the pickers read sensibly before load() resolves.
  const ROLE_BASES = [
    "planner",
    "critic",
    "docAgent",
    "recap",
    "distiller",
    "namer",
    "autopilot",
  ] as const;
  type RoleBase = (typeof ROLE_BASES)[number];
  const ROLE_CLI_SEED: Record<RoleBase, string> = {
    planner: "inherit",
    critic: "inherit",
    docAgent: "inherit",
    recap: "claude",
    namer: "claude",
    autopilot: "claude",
    distiller: "inherit",
  };
  const ROLE_MODEL_SEED: Record<RoleBase, string> = {
    planner: "default",
    critic: "default",
    docAgent: "default",
    recap: "sonnet",
    namer: "haiku",
    autopilot: "haiku",
    distiller: "default",
  };
  // Per-role reasoning-effort tier ("default"|<tier>), orthogonal to CLI/model — always shown.
  const ROLE_EFFORT_SEED: Record<RoleBase, string> = {
    planner: "default",
    critic: "high",
    docAgent: "low",
    recap: "low",
    namer: "low",
    autopilot: "low",
    distiller: "default",
  };
  let roleCli = $state<Record<RoleBase, string>>({ ...ROLE_CLI_SEED });
  let roleCliSaved: Record<RoleBase, string> = { ...ROLE_CLI_SEED };
  let roleModelV = $state<Record<RoleBase, string>>({ ...ROLE_MODEL_SEED });
  let roleModelSaved: Record<RoleBase, string> = { ...ROLE_MODEL_SEED };
  let roleEffortV = $state<Record<RoleBase, string>>({ ...ROLE_EFFORT_SEED });
  let roleEffortSaved: Record<RoleBase, string> = { ...ROLE_EFFORT_SEED };
  let roleBusy = $state<Record<RoleBase, boolean>>({
    planner: false,
    critic: false,
    docAgent: false,
    recap: false,
    namer: false,
    autopilot: false,
    distiller: false,
  });
  // Foreground (content) roles vs. collapsed classifiers (constant-cadence, kept cheap).
  const ROLE_PRIMARY: RoleBase[] = ["planner", "critic", "docAgent", "recap", "distiller"];
  const ROLE_CLASSIFIERS: RoleBase[] = ["namer", "autopilot"];

  function roleTitle(role: RoleBase): string {
    switch (role) {
      case "planner":
        return m.settings_role_model_planner_title();
      case "critic":
        return m.settings_role_model_critic_title();
      case "docAgent":
        return m.settings_role_model_docagent_title();
      case "recap":
        return m.settings_role_model_recap_title();
      case "namer":
        return m.settings_role_model_namer_title();
      case "autopilot":
        return m.settings_role_model_autopilot_title();
      case "distiller":
        return m.settings_role_model_distiller_title();
    }
  }
  function roleHint(role: RoleBase): string {
    switch (role) {
      case "planner":
        return m.settings_role_model_planner_hint();
      case "critic":
        return m.settings_role_model_critic_hint();
      case "docAgent":
        return m.settings_role_model_docagent_hint();
      case "recap":
        return m.settings_role_model_recap_hint();
      case "namer":
        return m.settings_role_model_namer_hint();
      case "autopilot":
        return m.settings_role_model_autopilot_hint();
      case "distiller":
        return m.settings_role_model_distiller_hint();
    }
  }
  // Display label for a CLI/provider (the CLI dropdown options + the effective line).
  function providerLabel(provider: string): string {
    return provider === "codex" ? m.settings_cli_codex() : m.settings_cli_claude();
  }
  // The model options for a role's currently-selected CLI (empty when it inherits).
  function roleModelOptions(role: RoleBase): readonly string[] {
    const cli = roleCli[role];
    return cli === "claude" || cli === "codex" ? MODELS_BY_PROVIDER[cli] : [];
  }
  // Client-side mirror of the server's resolveRoleEnvironment for the effective line and
  // model guidance. inherit → global provider+model; "default"/"auto" → provider default;
  // fable substitutes when off; a model not in the CLI's list clamps to the default.
  function resolvedRoleEnv(role: RoleBase): {
    provider: AgentProvider;
    model: string;
    label: string;
  } {
    const cli = roleCli[role];
    let provider: AgentProvider;
    let token: string;
    if (cli === "claude" || cli === "codex") {
      provider = cli;
      token = roleModelV[role];
      if (token !== "default" && !MODELS_BY_PROVIDER[cli].includes(token)) token = "default";
    } else {
      provider = defaultAgentProvider;
      token = provider === "codex" ? defaultCodexModel : defaultModel;
    }
    let model: string;
    let modelLbl: string;
    if (token === "auto" || token === "default") {
      model = "default";
      modelLbl = m.settings_role_model_effective_provider_default();
    } else {
      model = modelGuidanceAlias(token, fableAvailable);
      modelLbl = modelLabel(model);
    }
    return { provider, model, label: `${providerLabel(provider)} · ${modelLbl}` };
  }
  function effectiveEnvLabel(role: RoleBase): string {
    return resolvedRoleEnv(role).label;
  }
  function roleGuidanceProvider(role: RoleBase): AgentProvider {
    return resolvedRoleEnv(role).provider;
  }
  function roleGuidanceModel(role: RoleBase): string {
    return resolvedRoleEnv(role).model;
  }
  function roleGuidanceContext(role: RoleBase): "role" | "classifier" {
    return ROLE_CLASSIFIERS.includes(role) ? "classifier" : "role";
  }

  async function saveRoleCli(role: RoleBase) {
    if (roleBusy[role]) return;
    roleBusy[role] = true;
    try {
      const r = await putRoleCli(`${role}Cli`, roleCli[role]);
      const v = r[`${role}Cli`];
      if (typeof v === "string") {
        roleCli[role] = v;
        roleCliSaved[role] = v;
      }
      // If the new CLI doesn't offer the currently-selected model, snap the model back to its
      // provider default and persist that too — keeps the stored pair coherent.
      const opts = roleModelOptions(role);
      if (opts.length && roleModelV[role] !== "default" && !opts.includes(roleModelV[role])) {
        roleModelV[role] = "default";
        await saveRoleModel(role);
      }
      // Likewise, if the resolved provider no longer offers the current effort tier (e.g.
      // switching to codex drops xhigh/max), snap the effort back to "default" and persist.
      if (!effortAvailableForProvider(roleGuidanceProvider(role), roleEffortV[role])) {
        roleEffortV[role] = "default";
        await saveRoleEffort(role);
      }
    } catch {
      roleCli[role] = roleCliSaved[role]; // revert; surface a 12s, deduped alert
      toasts.info(m.settings_role_model_save_failed(), {
        key: `role-cli-${role}`,
        alert: true,
      });
    } finally {
      roleBusy[role] = false;
    }
  }

  async function saveRoleModel(role: RoleBase) {
    try {
      const r = await putRoleModel(`${role}Model`, roleModelV[role]);
      const v = r[`${role}Model`];
      if (typeof v === "string") {
        roleModelV[role] = v;
        roleModelSaved[role] = v;
      }
    } catch {
      roleModelV[role] = roleModelSaved[role]; // revert; surface a 12s, deduped alert
      toasts.info(m.settings_role_model_save_failed(), {
        key: `role-model-${role}`,
        alert: true,
      });
    }
  }

  async function saveRoleEffort(role: RoleBase) {
    try {
      const r = await putRoleEffort(`${role}Effort`, roleEffortV[role]);
      const v = r[`${role}Effort`];
      if (typeof v === "string") {
        roleEffortV[role] = v;
        roleEffortSaved[role] = v;
      }
    } catch {
      roleEffortV[role] = roleEffortSaved[role]; // revert; surface a 12s, deduped alert
      toasts.info(m.settings_role_model_save_failed(), {
        key: `role-effort-${role}`,
        alert: true,
      });
    }
  }

  async function saveDistillerInterval() {
    if (distillerIntervalBusy) return;
    distillerIntervalBusy = true;
    const value = Math.min(
      distillerIntervalDaysMax,
      Math.max(
        distillerIntervalDaysMin,
        Math.round(Number(distillerIntervalDays)) || distillerIntervalDaysMin,
      ),
    );
    try {
      const r = await putDistillerIntervalDays(value);
      distillerIntervalDays = r.distillerIntervalDays;
      distillerIntervalDaysSaved = r.distillerIntervalDays;
    } catch {
      distillerIntervalDays = distillerIntervalDaysSaved;
      toasts.info(m.settings_distiller_interval_save_failed(), {
        key: "distiller-interval",
        alert: true,
      });
    } finally {
      distillerIntervalBusy = false;
    }
  }
  let authMode = $state("subscription"); // how spawned agents authenticate
  let authModeSaved = "subscription"; // last server-confirmed value, for revert on failure
  let authBusy = $state(false);
  let hasApiKey = $state(false); // whether a key is configured (boolean only; key never sent)
  let apiKeyInput = $state(""); // write-only paste field; cleared after save, never prefilled
  // Inline verify-key result (probes whether the stored key actually authenticates).
  let verifyState = $state<"idle" | "verifying" | "ok" | "failed">("idle");
  let verifyMsg = $state(""); // resolved, localized failure message (incl. any verbatim detail)
  let extraCreditsCeiling = $state(0); // account-wide extra-credit spend ceiling (0 = pause on any)
  let extraCreditsCeilingSaved = 0; // last server-confirmed value, for revert on failure
  let extraCreditsBusy = $state(false);

  // Up Next picker skip — quick-start launches with the default coding CLI without asking.
  let upnextSkipCliPicker = $state(false);
  let upnextSkipCliPickerBusy = $state(false);

  // Usage hold — pause new tasks when usage is high and a session is already running.
  let usageHoldEnabled = $state(true);
  let usageHoldBusy = $state(false);
  let usageHoldPct = $state(80); // threshold percentage (0–100); matches server default
  let usageHoldPctSaved = 80;
  let usageHoldPctBusy = $state(false);

  // Usage-aware model downgrade — at/above the (lower) threshold every spawn runs on a cheap
  // model instead of pausing; the hold above still pauses at its (higher) threshold.
  let usageDowngradeEnabled = $state(false);
  let usageDowngradeBusy = $state(false);
  let usageDowngradePct = $state(70); // threshold percentage (0–100); matches server default (below hold)
  let usageDowngradePctSaved = 70;
  let usageDowngradePctBusy = $state(false);
  let usageDowngradeModel = $state("haiku"); // setting ("auto"|"default"|<alias>); matches server seed
  let usageDowngradeModelSaved = "haiku";
  let usageDowngradeModelBusy = $state(false);

  // Fable availability — operator kill-switch while Fable is globally unavailable.
  let fableAvailable = $state(true);
  let fableAvailableBusy = $state(false);

  // TUI fullscreen renderer — opt-in research preview for flatter memory on long runs.
  let tuiFullscreen = $state(false);
  let tuiFullscreenBusy = $state(false);

  // TUI disable-mouse — stop Claude Code from capturing the mouse in the agent terminal.
  let tuiDisableMouse = $state(false);
  let tuiDisableMouseBusy = $state(false);

  // Reduced-notifications mode — mutes all pushes except ready-after-5s + cost alerts.
  let reducedPushMode = $state(false);
  let reducedPushBusy = $state(false);

  // Repo root, resolved by the single getSettings() below and handed to the
  // workspace panel as props so it never re-fetches. settingsLoaded flips once
  // that load settles (success OR failure) so the child knows when to browse.
  let repoRoot = $state<string | null>(null);
  let repoRootDisplay = $state<string | null>(null);
  let settingsLoaded = $state(false);

  async function savePrReviewCycles() {
    if (prRcyBusy) return;
    prRcyBusy = true;
    // Clamp client-side to the server bounds before sending (the server clamps too);
    // an empty/NaN field falls back to the minimum rather than posting garbage.
    const n = Math.round(Number(prReviewCycles));
    const clamped = Number.isFinite(n)
      ? Math.min(prReviewCyclesMax, Math.max(prReviewCyclesMin, n))
      : prReviewCyclesMin;
    prReviewCycles = clamped;
    try {
      const r = await putPrReviewCyclesCap(clamped);
      prReviewCycles = r.prReviewCyclesCap;
      prReviewCyclesSaved = r.prReviewCyclesCap;
    } catch {
      // revert to the last server-confirmed value; surface the failure as a 12s,
      // deduped alert so the no-op never looks like a save.
      prReviewCycles = prReviewCyclesSaved;
      toasts.info(m.settings_pr_review_cycles_save_failed(), {
        key: "pr-review-cycles-cap",
        alert: true,
      });
    } finally {
      prRcyBusy = false;
    }
  }

  async function savePlanReviewCycles() {
    if (planRcyBusy) return;
    planRcyBusy = true;
    // Clamp client-side to the server bounds before sending (the server clamps too);
    // an empty/NaN field falls back to the minimum rather than posting garbage.
    const n = Math.round(Number(planReviewCycles));
    const clamped = Number.isFinite(n)
      ? Math.min(planReviewCyclesMax, Math.max(planReviewCyclesMin, n))
      : planReviewCyclesMin;
    planReviewCycles = clamped;
    try {
      const r = await putPlanReviewCyclesCap(clamped);
      planReviewCycles = r.planReviewCyclesCap;
      planReviewCyclesSaved = r.planReviewCyclesCap;
    } catch {
      // revert to the last server-confirmed value; surface the failure as a 12s,
      // deduped alert so the no-op never looks like a save.
      planReviewCycles = planReviewCyclesSaved;
      toasts.info(m.settings_plan_review_cycles_save_failed(), {
        key: "plan-review-cycles-cap",
        alert: true,
      });
    } finally {
      planRcyBusy = false;
    }
  }

  async function saveDefaultModel() {
    if (defaultModelBusy) return;
    defaultModelBusy = true;
    try {
      const r = await putDefaultModel(defaultModel);
      defaultModel = r.defaultModel;
      defaultModelSaved = r.defaultModel;
    } catch {
      // revert to the last server-confirmed value; surface the failure as a 12s,
      // deduped alert so the no-op never looks like a save.
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

  async function saveDefaultEffort() {
    if (defaultEffortBusy) return;
    defaultEffortBusy = true;
    try {
      const r = await putDefaultEffort(defaultEffort);
      defaultEffort = r.defaultEffort;
      defaultEffortSaved = r.defaultEffort;
    } catch {
      defaultEffort = defaultEffortSaved;
      toasts.info(m.settings_default_effort_save_failed(), {
        key: "default-effort",
        alert: true,
      });
    } finally {
      defaultEffortBusy = false;
    }
  }

  async function saveOperatorLanguage() {
    if (operatorLanguageBusy) return;
    operatorLanguageBusy = true;
    try {
      const r = await putOperatorLanguage(operatorLanguage);
      operatorLanguage = r.operatorLanguage;
      operatorLanguageSaved = r.operatorLanguage;
    } catch {
      operatorLanguage = operatorLanguageSaved;
      toasts.info(m.settings_operator_language_save_failed(), {
        key: "operator-language",
        alert: true,
      });
    } finally {
      operatorLanguageBusy = false;
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

  async function saveAuthMode() {
    if (authBusy) return;
    authBusy = true;
    try {
      const r = await putAuthMode(authMode);
      authMode = r.authMode;
      authModeSaved = r.authMode;
      hasApiKey = r.hasApiKey;
      // The verify result belongs only to api-key mode; drop it when leaving.
      if (r.authMode !== "api-key") {
        verifyState = "idle";
        verifyMsg = "";
      }
    } catch {
      // revert to the last server-confirmed value; surface the failure as a 12s alert.
      authMode = authModeSaved;
      toasts.info(m.settings_auth_mode_save_failed(), {
        key: "auth-mode",
        alert: true,
      });
    } finally {
      authBusy = false;
    }
  }

  async function saveApiKey() {
    if (authBusy || apiKeyInput.trim() === "") return;
    authBusy = true;
    let saved = false;
    try {
      const r = await putAnthropicApiKey(apiKeyInput.trim());
      hasApiKey = r.hasApiKey;
      saved = true;
      apiKeyInput = ""; // never retain the key in component state
    } catch {
      toasts.info(m.settings_auth_key_save_failed(), {
        key: "auth-key",
        alert: true,
      });
    } finally {
      authBusy = false;
    }
    // Only after a genuinely successful save — gate on the save outcome, not residual
    // `hasApiKey` (a replacement-save that throws must NOT auto-verify the old key) —
    // immediately probe whether it actually authenticates so a bad/expired key surfaces
    // here, not on first spawn.
    if (saved) await verifyKey();
  }

  // Probe the stored key against claude auth. Inline result only (no toast); guards
  // against concurrent runs so a double-click can't race two checks.
  async function verifyKey() {
    if (verifyState === "verifying") return;
    verifyState = "verifying";
    verifyMsg = "";
    try {
      const r = await verifyApiKey();
      if (r.ok) {
        verifyState = "ok";
      } else {
        verifyState = "failed";
        verifyMsg = verifyFailureMessage(r.reason, r.detail, {
          notAuthenticated: m.settings_auth_key_verify_not_authenticated,
          timeout: m.settings_auth_key_verify_timeout,
          generic: m.settings_auth_key_verify_error_generic,
        });
      }
    } catch {
      verifyState = "failed";
      verifyMsg = m.settings_auth_key_verify_error_generic();
    }
  }

  async function clearApiKey() {
    if (authBusy) return;
    authBusy = true;
    verifyState = "idle"; // a cleared key has no verdict
    verifyMsg = "";
    try {
      const r = await putAnthropicApiKey(null);
      hasApiKey = r.hasApiKey;
    } catch {
      toasts.info(m.settings_auth_key_save_failed(), {
        key: "auth-key",
        alert: true,
      });
    } finally {
      authBusy = false;
    }
  }

  async function saveExtraCreditsCeiling() {
    if (extraCreditsBusy) return;
    extraCreditsBusy = true;
    // Clamp to a non-negative number client-side (the server validates too); an
    // empty/NaN field falls back to 0 rather than posting garbage.
    const n = Number(extraCreditsCeiling);
    const clamped = Number.isFinite(n) && n >= 0 ? n : 0;
    extraCreditsCeiling = clamped;
    try {
      const r = await putExtraCreditsDrainCeiling(clamped);
      extraCreditsCeiling = r.extraCreditsDrainCeiling;
      extraCreditsCeilingSaved = r.extraCreditsDrainCeiling;
    } catch {
      // revert to the last server-confirmed value; surface the failure as a 12s,
      // deduped alert so the no-op never looks like a save.
      extraCreditsCeiling = extraCreditsCeilingSaved;
      toasts.info(m.settings_extra_credits_ceiling_save_failed(), {
        key: "extra-credits-ceiling",
        alert: true,
      });
    } finally {
      extraCreditsBusy = false;
    }
  }

  async function toggleUpnextSkipCliPicker() {
    if (upnextSkipCliPickerBusy) return;
    upnextSkipCliPickerBusy = true;
    const next = !upnextSkipCliPicker;
    try {
      const s = await putUpnextSkipCliPicker(next);
      upnextSkipCliPicker = s.upnextSkipCliPicker;
    } catch {
      toasts.info(m.settings_upnext_skip_cli_picker_save_failed(), {
        key: "upnext-skip-cli-picker",
        alert: true,
      });
    } finally {
      upnextSkipCliPickerBusy = false;
    }
  }

  async function toggleUsageHold() {
    if (usageHoldBusy) return;
    usageHoldBusy = true;
    const next = !usageHoldEnabled;
    try {
      const s = await putUsageHoldEnabled(next);
      usageHoldEnabled = s.usageHoldEnabled;
    } catch {
      toasts.info(m.settings_usage_hold_enabled_save_failed(), {
        key: "usage-hold-enabled",
        alert: true,
      });
    } finally {
      usageHoldBusy = false;
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

  async function toggleTuiFullscreen() {
    if (tuiFullscreenBusy) return;
    tuiFullscreenBusy = true;
    try {
      const r = await putTuiFullscreen(!tuiFullscreen);
      tuiFullscreen = r.tuiFullscreen;
    } catch {
      toasts.info(m.settings_tui_fullscreen_save_failed(), {
        key: "tui-fullscreen",
        alert: true,
      });
    } finally {
      tuiFullscreenBusy = false;
    }
  }

  async function toggleTuiDisableMouse() {
    if (tuiDisableMouseBusy) return;
    tuiDisableMouseBusy = true;
    try {
      const r = await putTuiDisableMouse(!tuiDisableMouse);
      tuiDisableMouse = r.tuiDisableMouse;
    } catch {
      toasts.info(m.settings_tui_disable_mouse_save_failed(), {
        key: "tui-disable-mouse",
        alert: true,
      });
    } finally {
      tuiDisableMouseBusy = false;
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

  async function toggleTelemetry() {
    if (telemetryBusy) return;
    telemetryBusy = true;
    const next = !telemetryOn;
    try {
      const r = await putTelemetryConsent(next ? "granted" : "denied");
      telemetryOn = r.telemetryConsent === "granted";
    } catch {
      toasts.info(m.settings_telemetry_save_failed(), {
        key: "telemetry-consent",
        alert: true,
      });
    } finally {
      telemetryBusy = false;
    }
  }

  async function saveUsageHoldPct() {
    if (usageHoldPctBusy) return;
    usageHoldPctBusy = true;
    const n = Math.round(Number(usageHoldPct));
    const clamped = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : usageHoldPctSaved;
    usageHoldPct = clamped;
    try {
      const r = await putUsageHoldPct(clamped);
      usageHoldPct = r.usageHoldPct;
      usageHoldPctSaved = r.usageHoldPct;
    } catch {
      usageHoldPct = usageHoldPctSaved;
      toasts.info(m.settings_usage_hold_pct_save_failed(), {
        key: "usage-hold-pct",
        alert: true,
      });
    } finally {
      usageHoldPctBusy = false;
    }
  }

  async function toggleUsageDowngrade() {
    if (usageDowngradeBusy) return;
    usageDowngradeBusy = true;
    const next = !usageDowngradeEnabled;
    try {
      const s = await putUsageDowngradeEnabled(next);
      usageDowngradeEnabled = s.usageDowngradeEnabled;
    } catch {
      toasts.info(m.settings_usage_downgrade_enabled_save_failed(), {
        key: "usage-downgrade-enabled",
        alert: true,
      });
    } finally {
      usageDowngradeBusy = false;
    }
  }

  async function saveUsageDowngradePct() {
    if (usageDowngradePctBusy) return;
    usageDowngradePctBusy = true;
    const n = Math.round(Number(usageDowngradePct));
    const clamped = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : usageDowngradePctSaved;
    usageDowngradePct = clamped;
    try {
      const r = await putUsageDowngradePct(clamped);
      usageDowngradePct = r.usageDowngradePct;
      usageDowngradePctSaved = r.usageDowngradePct;
    } catch {
      usageDowngradePct = usageDowngradePctSaved;
      toasts.info(m.settings_usage_downgrade_pct_save_failed(), {
        key: "usage-downgrade-pct",
        alert: true,
      });
    } finally {
      usageDowngradePctBusy = false;
    }
  }

  async function saveUsageDowngradeModel() {
    if (usageDowngradeModelBusy) return;
    usageDowngradeModelBusy = true;
    try {
      const r = await putUsageDowngradeModel(usageDowngradeModel);
      usageDowngradeModel = r.usageDowngradeModel;
      usageDowngradeModelSaved = r.usageDowngradeModel;
    } catch {
      usageDowngradeModel = usageDowngradeModelSaved;
      toasts.info(m.settings_usage_downgrade_model_save_failed(), {
        key: "usage-downgrade-model",
        alert: true,
      });
    } finally {
      usageDowngradeModelBusy = false;
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
    } catch {
      // the switch stays in its prior position (state only advances on success);
      // surface the failure so the no-op isn't silent.
      toasts.info(m.settings_housekeeping_save_failed(), {
        alert: true,
        key: "session-housekeeping",
      });
    } finally {
      hkBusy = false;
    }
  }

  // Apply the model / effort / operator-language preference trio from a loaded settings payload.
  // Extracted from onMount so each added preference doesn't grow that handler's branch count.
  function applyModelPrefs(s: Awaited<ReturnType<typeof getSettings>>) {
    defaultModel = s.defaultModel ?? "auto";
    defaultModelSaved = defaultModel;
    defaultCodexModel = s.defaultCodexModel ?? "gpt-5.5";
    defaultCodexModelSaved = defaultCodexModel;
    defaultEffort = s.defaultEffort ?? "default";
    defaultEffortSaved = defaultEffort;
    operatorLanguage = s.operatorLanguage ?? "en";
    operatorLanguageSaved = operatorLanguage;
  }

  function applyDistillerPrefs(s: Awaited<ReturnType<typeof getSettings>>) {
    distillerIntervalDays = s.distillerIntervalDays ?? 1;
    distillerIntervalDaysSaved = distillerIntervalDays;
    distillerIntervalDaysMin = s.distillerIntervalDaysMin ?? 1;
    distillerIntervalDaysMax = s.distillerIntervalDaysMax ?? 14;
  }

  onMount(async () => {
    try {
      const s = await getSettings();
      remoteControl = s.remoteControlAtStartup;
      housekeeping = s.sessionHousekeepingEnabled;
      retentionDays = s.sessionRetentionDays;
      retentionKeep = s.sessionRetentionKeep;
      prReviewCyclesMin = s.prReviewCyclesMin;
      prReviewCyclesMax = s.prReviewCyclesMax;
      prReviewCycles = s.prReviewCyclesCap;
      prReviewCyclesSaved = s.prReviewCyclesCap;
      planReviewCyclesMin = s.planReviewCyclesMin;
      planReviewCyclesMax = s.planReviewCyclesMax;
      planReviewCycles = s.planReviewCyclesCap;
      planReviewCyclesSaved = s.planReviewCyclesCap;
      applyModelPrefs(s);
      applyDistillerPrefs(s);
      // Fall back to the seed default per role when a field is absent (e.g. an older backend that
      // predates per-role environments) so the pickers never render blank — a sensible default is
      // always shown.
      const sr = s as unknown as Record<string, unknown>;
      for (const role of ROLE_BASES) {
        const cli = sr[`${role}Cli`];
        roleCli[role] = typeof cli === "string" ? cli : ROLE_CLI_SEED[role];
        const mdl = sr[`${role}Model`];
        roleModelV[role] = typeof mdl === "string" ? mdl : ROLE_MODEL_SEED[role];
        const eff = sr[`${role}Effort`];
        roleEffortV[role] = typeof eff === "string" ? eff : ROLE_EFFORT_SEED[role];
      }
      roleCliSaved = { ...roleCli };
      roleModelSaved = { ...roleModelV };
      roleEffortSaved = { ...roleEffortV };
      defaultAgentProvider = s.defaultAgentProvider ?? "claude";
      defaultAgentProviderSaved = s.defaultAgentProvider ?? "claude";
      upnextSkipCliPicker = s.upnextSkipCliPicker;
      authMode = s.authMode;
      authModeSaved = s.authMode;
      hasApiKey = s.hasApiKey;
      extraCreditsCeiling = s.extraCreditsDrainCeiling;
      extraCreditsCeilingSaved = s.extraCreditsDrainCeiling;
      usageHoldEnabled = s.usageHoldEnabled;
      usageHoldPct = s.usageHoldPct;
      usageHoldPctSaved = s.usageHoldPct;
      // Fall back to the server seed when a field is absent (older backend) so the controls
      // never render blank.
      usageDowngradeEnabled = s.usageDowngradeEnabled ?? false;
      usageDowngradePct = s.usageDowngradePct ?? 70;
      usageDowngradePctSaved = usageDowngradePct;
      usageDowngradeModel = s.usageDowngradeModel ?? "haiku";
      usageDowngradeModelSaved = usageDowngradeModel;
      fableAvailable = s.fableAvailable;
      tuiFullscreen = s.tuiFullscreen;
      tuiDisableMouse = s.tuiDisableMouse;
      reducedPushMode = s.reducedPushMode;
      telemetryOn = s.telemetryConsent === "granted";
      telemetryAvailable = s.telemetryAvailable;
      repoRoot = s.repoRoot;
      repoRootDisplay = s.repoRootDisplay;
    } catch {
      // settings load failed — session fields keep their defaults; the workspace
      // panel falls back to browsing the default dir (repoRoot stays null)
    } finally {
      settingsLoaded = true;
    }
  });
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

    <!-- herdr / codex / plugin update CTAs share one row shape; built as a list in
         the script so the template carries a single loop, not three near-identical
         `{#if}` blocks (keeps the <template> under the fallow complexity bar). -->
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

    {#if isNarrow}
      <!-- Narrow viewport: the strip can't fit one row in the card (and the
           full-screen card would clip the overflow), so the tabs collapse into a
           dropdown. The tablist isn't rendered here, so no tab carries a dangling
           aria-controls; the panels below stay labelled tabpanels. -->
      <div class="tab-select-wrap">
        <select class="tab-select" aria-label={m.settings_tabs_aria()} bind:value={tab}>
          {#each visibleTabs as t (t.id)}
            <option value={t.id}>{t.label()}</option>
          {/each}
        </select>
      </div>
    {:else}
      <div class="tabs" role="tablist" aria-label={m.settings_tabs_aria()}>
        {#each visibleTabs as t, i (t.id)}
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
    {/if}

    <!-- All three panels stay mounted and toggle via `hidden`: every
         settings-panel-* id resolves for the tabs' aria-controls, and the
         steers editor keeps any in-progress draft across tab switches
         instead of remounting and resyncing from the store. -->
    <div
      class="panel"
      use:panelShape={isNarrow}
      id="settings-panel-workspace"
      aria-label={m.settings_tab_workspace()}
      hidden={tab !== "workspace"}
    >
      <SettingsWorkspacePanel {repoRoot} {repoRootDisplay} {settingsLoaded} {onsaved} {onclose} />
    </div>

    <div
      class="panel"
      use:panelShape={isNarrow}
      id="settings-panel-codingAgents"
      aria-label={m.settings_tab_coding_agents()}
      hidden={tab !== "codingAgents"}
    >
      <SettingsDefaultEnvironment
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

      <div class="rc">
        <span class="micro">{m.settings_upnext_skip_cli_picker_label()}</span>
        <p class="hint">{m.settings_upnext_skip_cli_picker_hint()}</p>
        <button
          type="button"
          class="toggle"
          role="switch"
          aria-checked={upnextSkipCliPicker}
          disabled={upnextSkipCliPickerBusy}
          onclick={toggleUpnextSkipCliPicker}
        >
          <span class="track" class:on={upnextSkipCliPicker}><span class="knob"></span></span>
          <span class="state"
            >{upnextSkipCliPicker ? m.settings_usage_hold_on() : m.settings_usage_hold_off()}</span
          >
        </button>
      </div>

      <div class="cli-section">
        <div class="cli-head">
          <span class="micro">{m.settings_cli_claude_title()}</span>
          <p class="hint">{m.settings_cli_claude_hint()}</p>
        </div>
        <div class="rc">
          <span class="micro">{m.settings_default_effort_title()}</span>
          <p class="hint">{m.settings_default_effort_hint()}</p>
          <select
            class="model-select"
            bind:value={defaultEffort}
            disabled={defaultEffortBusy}
            aria-label={m.settings_default_effort_title()}
            onchange={saveDefaultEffort}
          >
            <option value="default">{m.settings_default_effort_default()}</option>
            {#each EFFORTS as tier (tier)}
              <option value={tier}>{effortLabel(tier)}</option>
            {/each}
          </select>
        </div>
        <div class="rc">
          <span class="micro">{m.settings_operator_language_title()}</span>
          <p class="hint">{m.settings_operator_language_hint()}</p>
          <select
            class="model-select"
            bind:value={operatorLanguage}
            disabled={operatorLanguageBusy}
            aria-label={m.settings_operator_language_title()}
            onchange={saveOperatorLanguage}
          >
            <option value="en">{m.lang_english()}</option>
            <option value="de">{m.lang_german()}</option>
          </select>
        </div>
        <div class="rc">
          <span class="micro">{m.settings_auth_mode_title()}</span>
          <p class="hint">{m.settings_auth_mode_hint()}</p>
          <select
            class="model-select"
            bind:value={authMode}
            disabled={authBusy}
            aria-label={m.settings_auth_mode_title()}
            onchange={saveAuthMode}
          >
            <option value="subscription">{m.settings_auth_mode_subscription()}</option>
            <option value="api-key">{m.settings_auth_mode_apikey()}</option>
          </select>
          {#if authMode === "api-key"}
            <div class="apikey">
              {#if hasApiKey}
                <p class="key-status">{m.settings_auth_key_saved()}</p>
                <div class="key-actions">
                  <button type="button" class="gbtn" disabled={authBusy} onclick={clearApiKey}>
                    {m.settings_auth_key_clear()}
                  </button>
                  <button
                    type="button"
                    class="gbtn"
                    disabled={authBusy || verifyState === "verifying"}
                    onclick={verifyKey}
                  >
                    {m.settings_auth_key_verify()}
                  </button>
                </div>
                {#if verifyState === "verifying"}
                  <p class="verify-line verify-busy">{m.settings_auth_key_verifying()}</p>
                {:else if verifyState === "ok"}
                  <p class="verify-line verify-ok">{m.settings_auth_key_verify_ok()}</p>
                {:else if verifyState === "failed"}
                  <p class="verify-line verify-failed">
                    {m.settings_auth_key_verify_failed()}
                    {verifyMsg}
                  </p>
                {/if}
              {/if}
              <div class="key-entry">
                <input
                  type="password"
                  class="model-select key-input"
                  bind:value={apiKeyInput}
                  disabled={authBusy}
                  placeholder={m.settings_auth_key_placeholder()}
                  aria-label={m.settings_auth_key_label()}
                  autocomplete="off"
                />
                <button
                  type="button"
                  class="gbtn"
                  disabled={authBusy || apiKeyInput.trim() === ""}
                  onclick={saveApiKey}
                >
                  {m.settings_auth_key_save()}
                </button>
              </div>
              {#if !hasApiKey}
                <p class="premium-warn">{m.settings_auth_key_missing_warning()}</p>
              {/if}
            </div>
          {/if}
        </div>
      </div>

      {#snippet roleRow(role: RoleBase)}
        <div class="rc">
          <span class="micro">{roleTitle(role)}</span>
          <p class="hint">{roleHint(role)}</p>
          <div class="cli-row">
            <select
              class="model-select"
              bind:value={roleCli[role]}
              disabled={roleBusy[role]}
              aria-label={m.settings_role_cli_label({ role: roleTitle(role) })}
              onchange={() => saveRoleCli(role)}
            >
              <option value="inherit">{m.settings_role_cli_inherit()}</option>
              {#each AGENT_PROVIDERS as p (p)}
                <option value={p}>{providerLabel(p)}</option>
              {/each}
            </select>
            {#if roleCli[role] !== "inherit"}
              <select
                class="model-select"
                bind:value={roleModelV[role]}
                disabled={roleBusy[role]}
                aria-label={m.settings_role_model_label({ role: roleTitle(role) })}
                onchange={() => saveRoleModel(role)}
              >
                <option value="default">{m.newtask_model_default()}</option>
                {#each roleModelOptions(role) as mdl (mdl)}
                  <option value={mdl}>{modelOptionLabel(roleGuidanceProvider(role), mdl)}</option>
                {/each}
              </select>
            {/if}
            <select
              class="model-select"
              bind:value={roleEffortV[role]}
              disabled={roleBusy[role]}
              aria-label={m.settings_role_effort_label({ role: roleTitle(role) })}
              onchange={() => saveRoleEffort(role)}
            >
              <option value="default">{m.effort_default()}</option>
              {#each providerEfforts(roleGuidanceProvider(role)) as tier (tier)}
                <option value={tier}>{effortLabel(tier)}</option>
              {/each}
            </select>
          </div>
          {#if role === "critic" && effortBelowHigh(roleEffortV[role])}
            <p class="premium-warn">{m.settings_critic_effort_weakened_warning()}</p>
          {/if}
          <p class="hint role-eff">
            {m.settings_role_model_effective({ model: effectiveEnvLabel(role) })}
          </p>
          <ModelGuidance
            provider={roleGuidanceProvider(role)}
            model={roleGuidanceModel(role)}
            context={roleGuidanceContext(role)}
          />
          {#if role === "distiller"}
            <label class="cycles">
              <span class="cycles-label">{m.settings_distiller_interval_label()}</span>
              <input
                class="num"
                type="number"
                min={distillerIntervalDaysMin}
                max={distillerIntervalDaysMax}
                step="1"
                disabled={distillerIntervalBusy}
                bind:value={distillerIntervalDays}
                aria-label={m.settings_distiller_interval_label()}
                onchange={saveDistillerInterval}
              />
            </label>
            <p class="hint">
              {m.settings_distiller_interval_hint({
                min: distillerIntervalDaysMin,
                max: distillerIntervalDaysMax,
              })}
            </p>
          {/if}
        </div>
      {/snippet}

      <div class="cli-section">
        <div class="cli-head">
          <span class="micro">{m.settings_role_models_title()}</span>
          <p class="hint">{m.settings_role_models_hint()}</p>
        </div>
        {#each ROLE_PRIMARY as role (role)}
          {@render roleRow(role)}
        {/each}
        <details class="role-advanced">
          <summary>{m.settings_role_models_advanced()}</summary>
          <p class="hint">{m.settings_role_models_classifier_cost_hint()}</p>
          {#each ROLE_CLASSIFIERS as role (role)}
            {@render roleRow(role)}
          {/each}
        </details>
      </div>

      <div class="cli-section">
        <div class="cli-head">
          <span class="micro">{m.settings_cli_codex_title()}</span>
          <p class="hint">{m.settings_cli_codex_hint()}</p>
        </div>
        <span class="micro">{m.settings_cli_codex_auth_title()}</span>
        <p class="hint">{m.settings_cli_codex_auth_hint()}</p>
        <select
          class="model-select"
          value="local"
          disabled
          aria-label={m.settings_cli_codex_auth_title()}
        >
          <option value="local">{m.settings_cli_codex_auth_local()}</option>
        </select>
      </div>
    </div>

    <div
      class="panel"
      use:panelShape={isNarrow}
      id="settings-panel-session"
      aria-label={m.settings_tab_session()}
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
      <div class="rc">
        <span class="micro">{m.settings_telemetry_title()}</span>
        <p class="hint">{m.settings_telemetry_hint()}</p>
        {#if telemetryAvailable}
          <button
            type="button"
            class="toggle"
            role="switch"
            aria-checked={telemetryOn}
            disabled={telemetryBusy}
            onclick={toggleTelemetry}
          >
            <span class="track" class:on={telemetryOn}><span class="knob"></span></span>
            <span class="state"
              >{telemetryOn ? m.settings_telemetry_on() : m.settings_telemetry_off()}</span
            >
          </button>
        {:else}
          <p class="hint">{m.settings_telemetry_unavailable()}</p>
        {/if}
      </div>
      <div class="rc">
        <span class="micro">{m.settings_pr_review_cycles_title()}</span>
        <p class="hint">
          {m.settings_pr_review_cycles_hint({ min: prReviewCyclesMin, max: prReviewCyclesMax })}
        </p>
        <label class="cycles">
          <span class="cycles-label">{m.settings_review_cycles_label()}</span>
          <input
            class="num"
            type="number"
            min={prReviewCyclesMin}
            max={prReviewCyclesMax}
            step="1"
            disabled={prRcyBusy}
            bind:value={prReviewCycles}
            aria-label={m.settings_pr_review_cycles_title()}
            onchange={savePrReviewCycles}
          />
        </label>
      </div>
      <div class="rc">
        <span class="micro">{m.settings_plan_review_cycles_title()}</span>
        <p class="hint">
          {m.settings_plan_review_cycles_hint({
            min: planReviewCyclesMin,
            max: planReviewCyclesMax,
          })}
        </p>
        <label class="cycles">
          <span class="cycles-label">{m.settings_review_cycles_label()}</span>
          <input
            class="num"
            type="number"
            min={planReviewCyclesMin}
            max={planReviewCyclesMax}
            step="1"
            disabled={planRcyBusy}
            bind:value={planReviewCycles}
            aria-label={m.settings_plan_review_cycles_title()}
            onchange={savePlanReviewCycles}
          />
        </label>
      </div>
      <div class="rc">
        <span class="micro">{m.restart_title()}</span>
        <p class="hint">{m.restart_settings_hint()}</p>
        <button type="button" class="gbtn" onclick={() => (restartOpen = true)}>
          {m.restart_button()}
        </button>
      </div>
      <div class="rc">
        <span class="micro">{m.settings_logout_title()}</span>
        <p class="hint">{m.settings_logout_hint()}</p>
        <button type="button" class="gbtn" onclick={() => logout()}>
          {m.settings_logout_button()}
        </button>
      </div>
      <div class="rc">
        <span class="micro">{m.settings_extra_credits_ceiling_title()}</span>
        <p class="hint">{m.settings_extra_credits_ceiling_hint()}</p>
        <label class="cycles">
          <span class="cycles-label">{m.settings_extra_credits_ceiling_label()}</span>
          <input
            class="num"
            type="number"
            min="0"
            step="1"
            disabled={extraCreditsBusy}
            bind:value={extraCreditsCeiling}
            aria-label={m.settings_extra_credits_ceiling_title()}
            onchange={saveExtraCreditsCeiling}
          />
        </label>
      </div>
      <div class="rc">
        <span class="micro">{m.settings_usage_hold_enabled_label()}</span>
        <p class="hint">{m.settings_usage_hold_hint()}</p>
        <button
          type="button"
          class="toggle"
          role="switch"
          aria-checked={usageHoldEnabled}
          disabled={usageHoldBusy}
          onclick={toggleUsageHold}
        >
          <span class="track" class:on={usageHoldEnabled}><span class="knob"></span></span>
          <span class="state"
            >{usageHoldEnabled ? m.settings_usage_hold_on() : m.settings_usage_hold_off()}</span
          >
        </button>
      </div>
      <div class="rc">
        <span class="micro">{m.settings_usage_hold_pct_label()}</span>
        <p class="hint">{m.settings_usage_hold_pct_hint()}</p>
        <label class="cycles">
          <span class="cycles-label">{m.settings_usage_hold_pct_field_label()}</span>
          <input
            class="num"
            type="number"
            min="0"
            max="100"
            step="1"
            disabled={usageHoldPctBusy || !usageHoldEnabled}
            bind:value={usageHoldPct}
            aria-label={m.settings_usage_hold_pct_label()}
            onchange={saveUsageHoldPct}
          />
        </label>
      </div>
      <div class="rc">
        <span class="micro">{m.settings_usage_downgrade_enabled_label()}</span>
        <p class="hint">{m.settings_usage_downgrade_hint()}</p>
        <button
          type="button"
          class="toggle"
          role="switch"
          aria-checked={usageDowngradeEnabled}
          disabled={usageDowngradeBusy}
          onclick={toggleUsageDowngrade}
        >
          <span class="track" class:on={usageDowngradeEnabled}><span class="knob"></span></span>
          <span class="state"
            >{usageDowngradeEnabled
              ? m.settings_usage_hold_on()
              : m.settings_usage_hold_off()}</span
          >
        </button>
      </div>
      <div class="rc">
        <span class="micro">{m.settings_usage_downgrade_pct_label()}</span>
        <p class="hint">{m.settings_usage_downgrade_pct_hint()}</p>
        <label class="cycles">
          <span class="cycles-label">{m.settings_usage_downgrade_pct_field_label()}</span>
          <input
            class="num"
            type="number"
            min="0"
            max="100"
            step="1"
            disabled={usageDowngradePctBusy || !usageDowngradeEnabled}
            bind:value={usageDowngradePct}
            aria-label={m.settings_usage_downgrade_pct_label()}
            onchange={saveUsageDowngradePct}
          />
        </label>
      </div>
      <div class="rc">
        <span class="micro">{m.settings_usage_downgrade_model_label()}</span>
        <p class="hint">{m.settings_usage_downgrade_model_hint()}</p>
        <select
          class="model-select"
          bind:value={usageDowngradeModel}
          disabled={usageDowngradeModelBusy || !usageDowngradeEnabled}
          aria-label={m.settings_usage_downgrade_model_label()}
          onchange={saveUsageDowngradeModel}
        >
          <!-- Concrete aliases only: "auto"/"default" resolve to null (no --model) via
               drainSpawnModel, which would make the downgrade a silent no-op. -->
          {#each MODELS as mdl (mdl)}
            <option value={mdl}>{modelOptionLabel("claude", mdl)}</option>
          {/each}
        </select>
        <ModelGuidance
          provider="claude"
          model={modelGuidanceAlias(usageDowngradeModel, fableAvailable)}
          context="downgrade"
        />
      </div>
      <div class="rc">
        <span class="micro">{m.settings_fable_available_label()}</span>
        <p class="hint">{m.settings_fable_available_hint()}</p>
        <button
          type="button"
          class="toggle"
          role="switch"
          aria-checked={fableAvailable}
          disabled={fableAvailableBusy}
          onclick={toggleFableAvailable}
        >
          <span class="track" class:on={fableAvailable}><span class="knob"></span></span>
          <span class="state"
            >{fableAvailable ? m.settings_usage_hold_on() : m.settings_usage_hold_off()}</span
          >
        </button>
      </div>
      <div class="rc">
        <span class="micro">{m.settings_tui_fullscreen_label()}</span>
        <p class="hint">{m.settings_tui_fullscreen_hint()}</p>
        <button
          type="button"
          class="toggle"
          role="switch"
          aria-checked={tuiFullscreen}
          disabled={tuiFullscreenBusy}
          onclick={toggleTuiFullscreen}
        >
          <span class="track" class:on={tuiFullscreen}><span class="knob"></span></span>
          <span class="state"
            >{tuiFullscreen ? m.settings_usage_hold_on() : m.settings_usage_hold_off()}</span
          >
        </button>
      </div>
      <div class="rc">
        <span class="micro">{m.settings_tui_disable_mouse_label()}</span>
        <p class="hint">{m.settings_tui_disable_mouse_hint()}</p>
        <button
          type="button"
          class="toggle"
          role="switch"
          aria-checked={tuiDisableMouse}
          disabled={tuiDisableMouseBusy}
          onclick={toggleTuiDisableMouse}
        >
          <span class="track" class:on={tuiDisableMouse}><span class="knob"></span></span>
          <span class="state"
            >{tuiDisableMouse ? m.settings_usage_hold_on() : m.settings_usage_hold_off()}</span
          >
        </button>
      </div>
      <div bind:this={steersEl}><SteersEditor {focusSteerId} /></div>
    </div>

    <div
      class="panel"
      use:panelShape={isNarrow}
      id="settings-panel-device"
      aria-label={m.settings_tab_device()}
      hidden={tab !== "device"}
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
      hidden={tab !== "diagnose"}
    >
      <SettingsDiagnosePanel {initialDiagnostics} />
    </div>

    <div
      class="panel"
      use:panelShape={isNarrow}
      id="settings-panel-plugins"
      aria-label={m.settings_tab_plugins()}
      hidden={tab !== "plugins"}
    >
      <SettingsPluginsPanel
        {plugins}
        {onpluginschanged}
        focusId={focusPluginId}
        updates={pluginUpdates}
        {onpluginapplied}
      />
    </div>
  </div>
</div>

{#if restartOpen}
  <RestartShepherdDialog onclose={() => (restartOpen = false)} />
{/if}

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
    width: min(560px, 92vw);
    height: min(680px, 86vh);
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
     it with a 2px amber border. Wraps to a second row when the fixed tab set
     can't fit one line in the card (e.g. longer German labels / larger
     --ui-scale) — keeps every tab visible without a scroller. */
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    border-bottom: 1px solid var(--color-line);
  }
  /* Narrow viewport: the strip becomes a dropdown (full-width, on the shared
     select recipe) so all tabs stay reachable inside the full-screen card.
     The wrapper carries the chevron so the box reads as a dropdown, not a
     heading — a pseudo-element on the <select> itself wouldn't render. */
  .tab-select-wrap {
    position: relative;
  }
  /* Custom chevron (the app's standard fold glyph) instead of the native
     browser arrow, kept on-token for cross-theme consistency. Decorative —
     pointer-events:none so taps pass through to the select. */
  .tab-select-wrap::after {
    content: "▾";
    position: absolute;
    top: 50%;
    right: 12px;
    transform: translateY(-50%);
    color: var(--color-muted);
    font-size: var(--fs-base);
    pointer-events: none;
  }
  .tab-select {
    box-sizing: border-box;
    width: 100%;
    min-height: 44px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    padding: 8px 32px 8px 10px;
    border-radius: 2px;
    appearance: none;
    -webkit-appearance: none;
    cursor: pointer;
  }
  .tab-select:focus {
    outline: none;
    border-color: var(--color-amber);
  }
  .tab {
    background: transparent;
    border: 0;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-meta);
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
    font-size: var(--fs-meta);
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
  .rc {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .cli-section {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 0 4px;
    border-top: 1px solid var(--color-line);
  }
  .cli-section:first-of-type {
    border-top: 0;
  }
  .cli-head {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .rc .hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0;
  }
  .cli-head .hint,
  .cli-section > .hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0;
  }
  /* Per-role "effective →" resolution line: a touch brighter than the plain hint so the
     actually-spawned model reads as the answer, not chrome. */
  .rc .hint.role-eff {
    color: var(--color-muted);
  }
  /* Collapsed classifiers group (namer/autopilot): a native, keyboard-reachable disclosure. */
  .role-advanced {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .role-advanced > summary {
    cursor: pointer;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .role-advanced > summary:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  /* Review-cycles stepper: an inline label + compact number input, mirroring the
     drain-cap control in AutomationPanel. */
  .cycles {
    display: flex;
    align-items: center;
    gap: 10px;
    align-self: flex-start;
  }
  .cycles-label {
    font-size: var(--fs-meta);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-ink-bright);
  }
  .cycles .num {
    width: 4.5em;
    border: 1px solid var(--color-line-bright);
    background: var(--color-inset);
    color: var(--color-ink-bright);
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    padding: 6px 8px;
    border-radius: 2px;
    min-height: 36px;
  }
  .cycles .num:focus {
    outline: none;
    border-color: var(--color-amber);
  }
  .cycles .num:disabled {
    opacity: 0.5;
  }
  .model-select {
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    padding: 8px 10px;
    border-radius: 2px;
    appearance: none;
    cursor: pointer;
    align-self: flex-start;
  }
  .model-select:focus {
    outline: none;
    border-color: var(--color-amber);
  }
  .model-select:disabled {
    opacity: 0.5;
    cursor: default;
  }
  /* Per-role environment: the CLI select + the model select sit side by side, wrapping on narrow
     viewports so neither is clipped on mobile. */
  .cli-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .cli-row .model-select {
    flex: 1 1 9rem;
    min-width: 9rem;
  }
  .premium-warn {
    color: var(--color-amber);
    font-size: var(--fs-meta);
    margin: 0;
    font-weight: 500;
  }
  .apikey {
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-self: stretch;
  }
  .key-entry {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .key-input {
    flex: 1 1 16rem;
    align-self: auto;
  }
  .key-status {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    margin: 0;
  }
  .key-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .verify-line {
    font-size: var(--fs-meta);
    margin: 0;
    font-weight: 500;
  }
  .verify-busy {
    color: var(--color-muted);
    font-weight: 400;
  }
  .verify-ok {
    color: var(--color-green);
  }
  .verify-failed {
    color: var(--color-red);
  }
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
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
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
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
    font-size: var(--fs-meta);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-ink-bright);
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
      overflow: hidden;
    }
  }
</style>
