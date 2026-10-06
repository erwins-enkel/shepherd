<script lang="ts">
  import { untrack } from "svelte";
  import {
    putRoleModel,
    putRoleEffort,
    putRoleCli,
    putDistillerIntervalDays,
    putUpnextSkipCliPicker,
    putDefaultEffort,
    putEngineEffort,
    putOperatorLanguage,
    putAuthMode,
    putAnthropicApiKey,
    verifyApiKey,
    type EngineEffortKey,
  } from "$lib/api";
  import { verifyFailureMessage } from "$lib/verify-key";
  import { configuredModelLabel } from "$lib/model-label";
  import { modelGuidanceAlias, modelOptionLabel } from "$lib/model-guidance";
  import {
    effortLabel,
    effortAvailableForProvider,
    providerEfforts,
    effortBelowHigh,
  } from "$lib/effort-guidance";
  import {
    AGENT_PROVIDERS,
    EFFORTS,
    MODELS_BY_PROVIDER,
    PREMIUM_MODELS,
    type AgentProvider,
    type Settings,
  } from "$lib/types";
  import {
    ROLE_BASES,
    type RoleBase,
    roleTitle,
    roleHint,
    codingCliRows,
    matchCount,
  } from "$lib/settings-search";
  import ModelGuidance from "$lib/components/ModelGuidance.svelte";
  import SettingRow from "./SettingRow.svelte";
  import SettingToggle from "./SettingToggle.svelte";
  import SettingsGroup from "./SettingsGroup.svelte";
  import HighlightText from "./HighlightText.svelte";
  import "./settings-controls.css";
  import { toasts } from "$lib/toasts.svelte";
  import { m } from "$lib/paraglide/messages";

  // The Coding CLI section: GLOBAL DEFAULTS as aligned label/control rows, then
  // DEFAULT PER ENGINE — one always-visible card per CLI (model, effort, auth) —
  // then Agent environments as a collapsed row that expands in place. Owns all
  // CLI-scoped state EXCEPT the provider/model trio, which stays in
  // Settings.svelte (its save/revert handlers are the tested contract and the
  // mobile section list needs the provider for its summary). Everything else
  // seeds once from the parent's single getSettings() payload.
  let {
    payload,
    query = "",
    defaultAgentProvider = $bindable(),
    defaultModel = $bindable(),
    defaultCodexModel = $bindable(),
    defaultAgentProviderBusy,
    defaultModelBusy,
    defaultCodexModelBusy,
    fableAvailable,
    onProviderChange,
    onClaudeModelChange,
    onCodexModelChange,
  }: {
    payload: Settings | null;
    query?: string;
    defaultAgentProvider: AgentProvider;
    defaultModel: string;
    defaultCodexModel: string;
    defaultAgentProviderBusy: boolean;
    defaultModelBusy: boolean;
    defaultCodexModelBusy: boolean;
    fableAvailable: boolean;
    onProviderChange: () => void | Promise<void>;
    onClaudeModelChange: () => void | Promise<void>;
    onCodexModelChange: () => void | Promise<void>;
  } = $props();

  const q = $derived(query.trim());

  // Capacity failover: the default above may be a temporary substitution the operator never
  // chose, so say so right where they'd otherwise read it as their own setting. Gated on the
  // bound value still BEING the substitution — picking another provider in the select clears the
  // failover server-side, and the note disappears with the same click rather than lingering
  // until the next settings fetch.
  const failover = $derived(payload?.providerFailover ?? null);
  // It also names what the substitute starts with — its own engine default, not the
  // effort meant for the engine it stands in for.
  const failoverNote = $derived(
    failover?.active && failover.from !== null && defaultAgentProvider === failover.current
      ? `${m.settings_default_cli_desc_failover({
          to: providerLabel(failover.current),
          from: providerLabel(failover.from),
        })} ${m.settings_default_cli_failover_engine({
          engine: providerLabel(failover.current),
          model: engineModelLabel(failover.current),
          effort: startsWithEffortLabel(failover.current),
        })}`
      : null,
  );

  // ── Local state (seeded from payload) ─────────────────────────────────────
  let defaultEffort = $state("default");
  let defaultEffortSaved = "default";
  let defaultEffortBusy = $state(false);
  // Per-engine default effort: "inherit" follows the global defaultEffort above.
  const ENGINE_EFFORT_KEY = {
    claude: "defaultClaudeEffort",
    codex: "defaultCodexEffort",
  } as const satisfies Record<AgentProvider, EngineEffortKey>;
  let engineEffort = $state<Record<AgentProvider, string>>({ claude: "inherit", codex: "inherit" });
  let engineEffortSaved: Record<AgentProvider, string> = { claude: "inherit", codex: "inherit" };
  let engineEffortBusy = $state<Record<AgentProvider, boolean>>({ claude: false, codex: false });
  let operatorLanguage = $state("en");
  let operatorLanguageSaved = "en";
  let operatorLanguageBusy = $state(false);
  let authMode = $state("subscription");
  let authModeSaved = "subscription";
  let authBusy = $state(false);
  let hasApiKey = $state(false);
  let apiKeyInput = $state("");
  let verifyState = $state<"idle" | "verifying" | "ok" | "failed">("idle");
  let verifyMsg = $state("");
  let upnextSkipCliPicker = $state(false);
  let upnextSkipCliPickerBusy = $state(false);
  let distillerIntervalDays = $state(1);
  let distillerIntervalDaysSaved = 1;
  let distillerIntervalDaysMin = $state(1);
  let distillerIntervalDaysMax = $state(14);
  let distillerIntervalBusy = $state(false);

  const ROLE_CLI_SEED: Record<RoleBase, string> = {
    planner: "inherit",
    critic: "inherit",
    docAgent: "inherit",
    recap: "claude",
    namer: "claude",
    autopilot: "claude",
    distiller: "inherit",
    optimizer: "inherit",
    mergeSuggest: "inherit",
  };
  const ROLE_MODEL_SEED: Record<RoleBase, string> = {
    planner: "default",
    critic: "default",
    docAgent: "default",
    recap: "sonnet",
    namer: "haiku",
    autopilot: "haiku",
    distiller: "default",
    optimizer: "default",
    mergeSuggest: "default",
  };
  const ROLE_EFFORT_SEED: Record<RoleBase, string> = {
    planner: "default",
    critic: "high",
    docAgent: "low",
    recap: "low",
    namer: "low",
    autopilot: "low",
    distiller: "default",
    optimizer: "default",
    mergeSuggest: "default",
  };
  let roleCli = $state<Record<RoleBase, string>>({ ...ROLE_CLI_SEED });
  let roleCliSaved: Record<RoleBase, string> = { ...ROLE_CLI_SEED };
  let roleModelV = $state<Record<RoleBase, string>>({ ...ROLE_MODEL_SEED });
  let roleModelSaved: Record<RoleBase, string> = { ...ROLE_MODEL_SEED };
  let roleEffortV = $state<Record<RoleBase, string>>({ ...ROLE_EFFORT_SEED });
  let roleEffortSaved: Record<RoleBase, string> = { ...ROLE_EFFORT_SEED };
  let roleBusy = $state<Record<RoleBase, boolean>>(
    Object.fromEntries(ROLE_BASES.map((r) => [r, false])) as Record<RoleBase, boolean>,
  );
  const ROLE_PRIMARY: RoleBase[] = [
    "planner",
    "critic",
    "docAgent",
    "recap",
    "distiller",
    "optimizer",
    "mergeSuggest",
  ];
  const ROLE_CLASSIFIERS: RoleBase[] = ["namer", "autopilot"];

  // Seed once from the parent's single getSettings() payload. Falls back to
  // the seed default per field (older backend) so the pickers never render blank.
  let seeded = false;
  $effect(() => {
    if (!payload || seeded) return;
    seeded = true;
    const s = payload;
    untrack(() => {
      defaultEffort = s.defaultEffort ?? "default";
      defaultEffortSaved = defaultEffort;
      engineEffort = {
        claude: s.defaultClaudeEffort ?? "inherit",
        codex: s.defaultCodexEffort ?? "inherit",
      };
      engineEffortSaved = { ...engineEffort };
      operatorLanguage = s.operatorLanguage ?? "en";
      operatorLanguageSaved = operatorLanguage;
      authMode = s.authMode;
      authModeSaved = s.authMode;
      hasApiKey = s.hasApiKey;
      upnextSkipCliPicker = s.upnextSkipCliPicker;
      distillerIntervalDays = s.distillerIntervalDays ?? 1;
      distillerIntervalDaysSaved = distillerIntervalDays;
      distillerIntervalDaysMin = s.distillerIntervalDaysMin ?? 1;
      distillerIntervalDaysMax = s.distillerIntervalDaysMax ?? 14;
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
    });
  });

  // ── Derivations ───────────────────────────────────────────────────────────
  const isPremiumModel = $derived(PREMIUM_MODELS.includes(defaultModel));
  const is1mModel = $derived(defaultModel.endsWith("[1m]"));
  // Each engine card's model, as the guidance and effort tiers read it.
  const engineModel = $derived<Record<AgentProvider, string>>({
    claude: modelGuidanceAlias(defaultModel, fableAvailable),
    codex: defaultCodexModel,
  });

  // Group rows from the shared search index — counts ("N settings") and search
  // auto-expand both derive from it, so they can't drift from the copy.
  const groupRows = codingCliRows();
  let rolesOpen = $state(false);
  const rolesExpanded = $derived(rolesOpen || (q !== "" && matchCount(groupRows.roles, q) > 0));

  function providerLabel(provider: string): string {
    return provider === "codex" ? m.settings_cli_codex() : m.settings_cli_claude();
  }
  /** The model an engine starts with, as the "Starts with" line names it. */
  function engineModelLabel(provider: AgentProvider): string {
    const token = provider === "codex" ? defaultCodexModel : defaultModel;
    return token === "auto" || token === "default"
      ? m.settings_role_model_effective_provider_default()
      : configuredModelLabel(modelGuidanceAlias(token, fableAvailable));
  }
  /** The effort an engine starts with: its own default unless it follows the global one. */
  function startsWithEffortLabel(provider: AgentProvider): string {
    const own = engineEffort[provider];
    const setting = own === "inherit" ? defaultEffort : own;
    return setting === "default" ? m.settings_engine_effort_cli_default() : effortLabel(setting);
  }
  /** Tiers offered for an engine's current model; a stored tier it lacks stays selectable. */
  function engineEffortTiers(provider: AgentProvider): readonly string[] {
    const model = engineModel[provider];
    return providerEfforts(provider, model === "default" || model === "auto" ? null : model);
  }
  function roleModelOptions(role: RoleBase): readonly string[] {
    const cli = roleCli[role];
    return cli === "claude" || cli === "codex" ? MODELS_BY_PROVIDER[cli] : [];
  }
  // Client-side mirror of the server's resolveRoleEnvironment for the effective
  // line and model guidance. inherit → global provider+model; "default"/"auto"
  // → provider default; fable substitutes when off; a model not in the CLI's
  // list clamps to the default.
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
      // Configured label: this line states what the role WILL use, so it must match
      // the picker above it ("Opus (latest)"), not the record label a session card shows.
      modelLbl = configuredModelLabel(model);
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

  // ── Save handlers (immediate persist, revert + deduped alert on failure) ──
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
      // If the new CLI doesn't offer the currently-selected model, snap the
      // model back to its provider default and persist that too — keeps the
      // stored pair coherent.
      const opts = roleModelOptions(role);
      if (opts.length && roleModelV[role] !== "default" && !opts.includes(roleModelV[role])) {
        roleModelV[role] = "default";
        await saveRoleModel(role);
      }
      // A manual provider/model change resets only an unsupported effort choice.
      if (
        !effortAvailableForProvider(
          roleGuidanceProvider(role),
          roleEffortV[role],
          roleGuidanceModel(role),
        )
      ) {
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
        if (
          !effortAvailableForProvider(
            roleGuidanceProvider(role),
            roleEffortV[role],
            roleGuidanceModel(role),
          )
        ) {
          roleEffortV[role] = "default";
          await saveRoleEffort(role);
        }
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

  async function saveEngineEffort(provider: AgentProvider) {
    if (engineEffortBusy[provider]) return;
    engineEffortBusy[provider] = true;
    const key = ENGINE_EFFORT_KEY[provider];
    try {
      const r = await putEngineEffort(key, engineEffort[provider]);
      const v = r[key];
      if (typeof v === "string") {
        engineEffort[provider] = v;
        engineEffortSaved[provider] = v;
      }
    } catch {
      engineEffort[provider] = engineEffortSaved[provider];
      toasts.info(m.settings_engine_effort_save_failed({ engine: providerLabel(provider) }), {
        key: `engine-effort-${provider}`,
        alert: true,
      });
    } finally {
      engineEffortBusy[provider] = false;
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
    // Only after a genuinely successful save — gate on the save outcome, not
    // residual `hasApiKey` (a replacement-save that throws must NOT auto-verify
    // the old key) — immediately probe whether it actually authenticates.
    if (saved) await verifyKey();
  }

  // Probe the stored key against claude auth. Inline result only (no toast);
  // guards against concurrent runs so a double-click can't race two checks.
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
</script>

<div class="glabel">{m.settings_cli_defaults_title()}</div>

<SettingRow
  title={m.settings_default_agent_provider_title()}
  description={failoverNote ?? m.settings_default_cli_desc()}
  {query}
>
  {#snippet control()}
    <span class="set-select">
      <select
        bind:value={defaultAgentProvider}
        disabled={defaultAgentProviderBusy}
        aria-label={m.settings_default_agent_provider_title()}
        onchange={onProviderChange}
      >
        {#each AGENT_PROVIDERS as provider (provider)}
          <option value={provider}>
            {provider === "claude" ? m.agent_provider_claude() : m.agent_provider_codex_alpha()}
          </option>
        {/each}
      </select>
      <span class="set-chev" aria-hidden="true">▾</span>
    </span>
  {/snippet}
</SettingRow>

<SettingRow
  title={m.settings_default_effort_title()}
  description={m.settings_default_effort_hint()}
  {query}
>
  {#snippet control()}
    <span class="set-select">
      <select
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
      <span class="set-chev" aria-hidden="true">▾</span>
    </span>
  {/snippet}
</SettingRow>

<SettingRow
  title={m.settings_operator_language_title()}
  description={m.settings_operator_language_hint()}
  {query}
>
  {#snippet control()}
    <span class="set-select">
      <select
        bind:value={operatorLanguage}
        disabled={operatorLanguageBusy}
        aria-label={m.settings_operator_language_title()}
        onchange={saveOperatorLanguage}
      >
        <option value="en">{m.lang_english()}</option>
        <option value="de">{m.lang_german()}</option>
      </select>
      <span class="set-chev" aria-hidden="true">▾</span>
    </span>
  {/snippet}
</SettingRow>

<SettingRow
  title={m.settings_upnext_skip_cli_picker_label()}
  description={m.settings_upnext_skip_cli_picker_hint()}
  {query}
  inlineOnMobile
  onrowclick={toggleUpnextSkipCliPicker}
>
  {#snippet control()}
    <SettingToggle
      checked={upnextSkipCliPicker}
      disabled={upnextSkipCliPickerBusy}
      label={m.settings_upnext_skip_cli_picker_label()}
      onchange={toggleUpnextSkipCliPicker}
    />
  {/snippet}
</SettingRow>

<div class="glabel engines-label">
  <HighlightText text={m.settings_engine_defaults_title()} query={q} />
</div>
<p class="rhint engines-hint">
  <HighlightText text={m.settings_engine_defaults_hint()} query={q} />
</p>

{#snippet engineHead(provider: AgentProvider)}
  <div class="ehead">
    <h4 class="ename"><HighlightText text={providerLabel(provider)} query={q} /></h4>
    {#if defaultAgentProvider === provider}
      <span class="badge">{m.settings_engine_default_cli_badge()}</span>
    {/if}
  </div>
{/snippet}

{#snippet modelOptions(provider: AgentProvider)}
  {#each MODELS_BY_PROVIDER[provider] as mdl (mdl)}
    <option value={mdl}>{modelOptionLabel(provider, mdl)}</option>
  {/each}
{/snippet}

<!-- An effort select's tiers; a stored tier the CLI/model doesn't offer stays selectable. -->
{#snippet tierOptions(value: string, tiers: readonly string[])}
  {#if value !== "default" && value !== "inherit" && !tiers.includes(value)}
    <option {value}>{effortLabel(value)}</option>
  {/if}
  {#each tiers as tier (tier)}
    <option value={tier}>{effortLabel(tier)}</option>
  {/each}
{/snippet}

{#snippet engineEffortField(provider: AgentProvider)}
  <label class="efield">
    <span class="elabel"><HighlightText text={m.settings_engine_effort_label()} query={q} /></span>
    <span class="set-select">
      <select
        bind:value={engineEffort[provider]}
        disabled={engineEffortBusy[provider]}
        aria-label={m.settings_engine_effort_aria({ engine: providerLabel(provider) })}
        onchange={() => saveEngineEffort(provider)}
      >
        <option value="inherit">
          {m.settings_engine_effort_inherit({
            effort: defaultEffort === "default" ? m.effort_default() : effortLabel(defaultEffort),
          })}
        </option>
        <option value="default">{m.settings_engine_effort_cli_default()}</option>
        {@render tierOptions(engineEffort[provider], engineEffortTiers(provider))}
      </select>
      <span class="set-chev" aria-hidden="true">▾</span>
    </span>
  </label>
  <div class="starts">
    <span class="starts-label">{m.settings_engine_starts_with()}</span>
    <span class="starts-value"
      >{engineModelLabel(provider)} · {startsWithEffortLabel(provider)}</span
    >
    <span class="starts-source">
      {engineEffort[provider] === "inherit"
        ? m.settings_engine_effort_source_inherit()
        : m.settings_engine_effort_source_own()}
    </span>
  </div>
{/snippet}

<div class="engines">
  <section class="engine" aria-label={providerLabel("claude")}>
    {@render engineHead("claude")}
    <label class="efield">
      <span class="elabel"><HighlightText text={m.settings_engine_model_label()} query={q} /></span>
      <span class="set-select">
        <select
          data-testid="default-claude-model"
          bind:value={defaultModel}
          disabled={defaultModelBusy}
          aria-label={m.settings_default_model_title()}
          onchange={onClaudeModelChange}
        >
          <option value="auto">{m.settings_default_model_auto()}</option>
          <option value="default">{m.newtask_model_default()}</option>
          {@render modelOptions("claude")}
        </select>
        <span class="set-chev" aria-hidden="true">▾</span>
      </span>
    </label>
    <div class="meta">
      <ModelGuidance metaChips provider="claude" model={engineModel.claude} context="default" />
      {#if isPremiumModel}
        <p class="premium-warn">{m.settings_default_model_premium_warning()}</p>
      {/if}
      {#if is1mModel}
        <p class="premium-warn">{m.settings_default_model_1m_note()}</p>
      {/if}
    </div>
    {@render engineEffortField("claude")}
    <label class="efield">
      <span class="elabel"><HighlightText text={m.settings_auth_mode_title()} query={q} /></span>
      <span class="set-select">
        <select
          bind:value={authMode}
          disabled={authBusy}
          aria-label={m.settings_engine_auth_aria({ engine: providerLabel("claude") })}
          onchange={saveAuthMode}
        >
          <option value="subscription">{m.settings_auth_mode_subscription()}</option>
          <option value="api-key">{m.settings_auth_mode_apikey()}</option>
        </select>
        <span class="set-chev" aria-hidden="true">▾</span>
      </span>
    </label>
    <p class="rhint"><HighlightText text={m.settings_auth_mode_hint()} query={q} /></p>
    {#if authMode === "api-key"}
      <div class="apikey">
        {#if hasApiKey}
          <p class="key-status">{m.settings_auth_key_saved()}</p>
          <div class="key-actions">
            <button type="button" class="set-gbtn" disabled={authBusy} onclick={clearApiKey}>
              {m.settings_auth_key_clear()}
            </button>
            <button
              type="button"
              class="set-gbtn"
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
            class="key-input"
            bind:value={apiKeyInput}
            disabled={authBusy}
            placeholder={m.settings_auth_key_placeholder()}
            aria-label={m.settings_auth_key_label()}
            autocomplete="off"
          />
          <button
            type="button"
            class="set-gbtn"
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
  </section>

  <section class="engine" aria-label={providerLabel("codex")}>
    {@render engineHead("codex")}
    <label class="efield">
      <span class="elabel"><HighlightText text={m.settings_engine_model_label()} query={q} /></span>
      <span class="set-select">
        <select
          data-testid="default-codex-model"
          bind:value={defaultCodexModel}
          disabled={defaultCodexModelBusy}
          aria-label={m.settings_default_codex_model_title()}
          onchange={onCodexModelChange}
        >
          <option value="default">{m.newtask_model_default()}</option>
          {@render modelOptions("codex")}
        </select>
        <span class="set-chev" aria-hidden="true">▾</span>
      </span>
    </label>
    <div class="meta">
      <ModelGuidance metaChips provider="codex" model={engineModel.codex} context="default" />
    </div>
    {@render engineEffortField("codex")}
    <label class="efield">
      <span class="elabel"
        ><HighlightText text={m.settings_cli_codex_auth_title()} query={q} /></span
      >
      <span class="set-select">
        <select
          value="local"
          disabled
          aria-label={m.settings_engine_auth_aria({ engine: providerLabel("codex") })}
        >
          <option value="local">{m.settings_cli_codex_auth_local()}</option>
        </select>
        <span class="set-chev" aria-hidden="true">▾</span>
      </span>
    </label>
    <p class="rhint"><HighlightText text={m.settings_cli_codex_auth_hint()} query={q} /></p>
  </section>
</div>

<p class="rhint engines-foot">
  <HighlightText text={m.settings_engine_defaults_precedence()} query={q} />
</p>

<div class="group-lead"></div>

{#snippet roleRow(role: RoleBase)}
  <div class="rrow">
    <span class="rtitle"><HighlightText text={roleTitle(role)} query={q} /></span>
    <p class="rhint"><HighlightText text={roleHint(role)} query={q} /></p>
    <div class="cli-row">
      <span class="set-select">
        <select
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
        <span class="set-chev" aria-hidden="true">▾</span>
      </span>
      {#if roleCli[role] !== "inherit"}
        <span class="set-select">
          <select
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
          <span class="set-chev" aria-hidden="true">▾</span>
        </span>
      {/if}
      <span class="set-select">
        <select
          bind:value={roleEffortV[role]}
          disabled={roleBusy[role]}
          aria-label={m.settings_role_effort_label({ role: roleTitle(role) })}
          onchange={() => saveRoleEffort(role)}
        >
          <option value="default">{m.effort_default()}</option>
          {@render tierOptions(
            roleEffortV[role],
            providerEfforts(roleGuidanceProvider(role), roleGuidanceModel(role)),
          )}
        </select>
        <span class="set-chev" aria-hidden="true">▾</span>
      </span>
    </div>
    {#if role === "critic" && effortBelowHigh(roleEffortV[role])}
      <p class="premium-warn">{m.settings_critic_effort_weakened_warning()}</p>
    {/if}
    <p class="rhint role-eff">
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
          class="set-num"
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
      <p class="rhint">
        {m.settings_distiller_interval_hint({
          min: distillerIntervalDaysMin,
          max: distillerIntervalDaysMax,
        })}
      </p>
    {/if}
  </div>
{/snippet}

<SettingsGroup
  label={m.settings_role_models_title()}
  count={groupRows.roles.length}
  expanded={rolesExpanded}
  ontoggle={() => (rolesOpen = !rolesExpanded)}
>
  <p class="rhint section-hint">{m.settings_role_models_hint()}</p>
  {#each ROLE_PRIMARY as role (role)}
    {@render roleRow(role)}
  {/each}
  <details class="role-advanced">
    <summary>{m.settings_role_models_advanced()}</summary>
    <p class="rhint">{m.settings_role_models_classifier_cost_hint()}</p>
    {#each ROLE_CLASSIFIERS as role (role)}
      {@render roleRow(role)}
    {/each}
  </details>
</SettingsGroup>

<style>
  .glabel {
    font-size: var(--fs-micro);
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--color-faint);
    padding: 10px 0 6px;
  }
  /* The engine cards end the open part of the section; this hairline sits
     above the collapsed Agent environments row. */
  .group-lead {
    border-top: 1px solid var(--color-line);
  }
  /* DEFAULT PER ENGINE: its label also closes the last GLOBAL DEFAULTS row,
     which carries only a top hairline. */
  .engines-label {
    border-top: 1px solid var(--color-line);
    margin-top: 6px;
    padding-top: 16px;
  }
  .engines-hint {
    padding-bottom: 12px;
  }
  .engines {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 12px;
  }
  .engine {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
    padding: 14px;
    background: var(--color-panel-2);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
  }
  .ehead {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .ename {
    margin: 0;
    font-size: var(--fs-base);
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--color-ink-bright);
  }
  .badge {
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
  }
  .efield {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .elabel {
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .starts {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 10px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
  }
  .starts-label {
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .starts-value {
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
  }
  .starts-source {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .engines-foot {
    padding: 10px 0 14px;
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 2px;
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
    padding-top: 4px;
  }
  .key-entry {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .key-input {
    flex: 1 1 16rem;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-base);
    padding: 6px 10px;
  }
  .key-input:focus {
    outline: none;
    border-color: var(--color-amber);
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
  .rrow {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 0;
    border-top: 1px solid var(--color-line);
  }
  .rrow:first-of-type {
    border-top: 0;
  }
  .rtitle {
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
  }
  .rhint {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.5;
    margin: 0;
  }
  .rhint.role-eff {
    color: var(--color-muted);
  }
  .section-hint {
    color: var(--color-faint);
    padding-top: 8px;
  }
  .cli-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .cli-row :global(.set-select) {
    flex: 1 1 9rem;
    min-width: 9rem;
    width: auto;
  }
  .role-advanced {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px 0;
    border-top: 1px solid var(--color-line);
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
  .cycles :global(.set-num) {
    width: 4.5em;
  }

  @media (max-width: 768px) {
    .glabel {
      font-size: var(--fs-meta);
      padding: 14px 0 6px;
    }
    .key-input {
      min-height: 44px;
      font-size: var(--fs-lg);
    }
    .rtitle {
      font-size: var(--fs-lg);
    }
    .rhint {
      font-size: var(--fs-base);
    }
    .elabel,
    .starts-label {
      font-size: var(--fs-meta);
    }
    .engine :global(.set-select select) {
      min-height: 44px;
    }
  }
</style>
