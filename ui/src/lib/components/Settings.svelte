<script lang="ts">
  import { onMount, untrack } from "svelte";
  import {
    getSettings,
    putRemoteControl,
    putSessionHousekeeping,
    putPrReviewCyclesCap,
    putPlanReviewCyclesCap,
    putDefaultModel,
    putAuthMode,
    putAnthropicApiKey,
    verifyApiKey,
    putExtraCreditsDrainCeiling,
    putUsageHoldEnabled,
    putUsageHoldPct,
    putFableAvailable,
  } from "$lib/api";
  import { verifyFailureMessage } from "$lib/verify-key";
  import { modelLabel } from "$lib/model-label";
  import { MODELS, PREMIUM_MODELS, type HerdrUpdateStatus, type DiagnosticCheck } from "$lib/types";
  import SteersEditor from "$lib/components/SteersEditor.svelte";
  import SettingsWorkspacePanel from "$lib/components/settings/SettingsWorkspacePanel.svelte";
  import SettingsDevicePanel from "$lib/components/settings/SettingsDevicePanel.svelte";
  import SettingsDiagnosePanel from "$lib/components/settings/SettingsDiagnosePanel.svelte";
  import { dialog } from "$lib/a11yDialog";
  import { toasts } from "$lib/toasts.svelte";
  import { m } from "$lib/paraglide/messages";

  // Settings group into three jobs so the modal never outgrows the viewport:
  // WORKSPACE (which repo root), SESSION (how agents start + steer), DEVICE
  // (this browser's notifications + theme). The HERDR-update CTA is an alert,
  // not a section, so it stays pinned above the tab strip.
  const TABS = [
    { id: "workspace", label: m.settings_tab_workspace },
    { id: "session", label: m.settings_tab_session },
    { id: "device", label: m.settings_tab_device },
    { id: "diagnose", label: m.settings_tab_diagnose },
  ] as const;
  type TabId = (typeof TABS)[number]["id"];
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
    onfork,
    herdrUpdate = null,
    onherdrupdate,
    onwhatsnew,
    initialTab = "workspace",
    initialDiagnostics = null,
  }: {
    onclose?: () => void;
    onsaved?: (root: string) => void;
    onclone?: () => void;
    onfork?: () => void;
    herdrUpdate?: HerdrUpdateStatus | null;
    onherdrupdate?: () => void;
    onwhatsnew?: () => void;
    initialTab?: TabId;
    /** Pre-seeded diagnostics checks from the store; loaded fresh on tab open if absent. */
    initialDiagnostics?: DiagnosticCheck[] | null;
  } = $props();

  // initialTab seeds the starting tab; the user then freely switches it, so we
  // only ever read the prop once (untrack silences the initial-value warning).
  let tab = $state<TabId>(untrack(() => initialTab));
  let steersEl = $state<HTMLDivElement | null>(null);

  onMount(() => {
    if (initialTab === "session") {
      requestAnimationFrame(() => steersEl?.scrollIntoView({ behavior: "auto", block: "start" }));
    }
  });

  // On a phone the HERDR badge folds into the gear; its update flow lands here.
  const herdrUpdateAvailable = $derived(!!herdrUpdate && herdrUpdate.updateAvailable);

  let remoteControl = $state(false); // Claude Code Remote Control auto-start in sessions
  let rcBusy = $state(false);
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
  const isPremiumModel = $derived(PREMIUM_MODELS.includes(defaultModel));
  // 1M-context variants ("opus[1m]"/"sonnet[1m]") carry an extra per-turn cost the
  // generic premium warning doesn't convey, so they surface an additional note.
  const is1mModel = $derived(defaultModel.endsWith("[1m]"));
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

  // Usage hold — pause new tasks when usage is high and a session is already running.
  let usageHoldEnabled = $state(true);
  let usageHoldBusy = $state(false);
  let usageHoldPct = $state(80); // threshold percentage (0–100); matches server default
  let usageHoldPctSaved = 80;
  let usageHoldPctBusy = $state(false);

  // Fable availability — operator kill-switch while Fable is globally unavailable.
  let fableAvailable = $state(true);
  let fableAvailableBusy = $state(false);

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
      // revert to the last server-confirmed value; surface the failure as a persistent,
      // deduped alert so the no-op never looks like a save.
      prReviewCycles = prReviewCyclesSaved;
      toasts.info(m.settings_pr_review_cycles_save_failed(), {
        key: "pr-review-cycles-cap",
        duration: null,
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
      // revert to the last server-confirmed value; surface the failure as a persistent,
      // deduped alert so the no-op never looks like a save.
      planReviewCycles = planReviewCyclesSaved;
      toasts.info(m.settings_plan_review_cycles_save_failed(), {
        key: "plan-review-cycles-cap",
        duration: null,
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
      // revert to the last server-confirmed value; surface the failure as a persistent,
      // deduped alert so the no-op never looks like a save.
      defaultModel = defaultModelSaved;
      toasts.info(m.settings_default_model_save_failed(), {
        key: "default-model",
        duration: null,
        alert: true,
      });
    } finally {
      defaultModelBusy = false;
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
      // revert to the last server-confirmed value; surface the failure persistently.
      authMode = authModeSaved;
      toasts.info(m.settings_auth_mode_save_failed(), {
        key: "auth-mode",
        duration: null,
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
        duration: null,
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
        duration: null,
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
      // revert to the last server-confirmed value; surface the failure as a persistent,
      // deduped alert so the no-op never looks like a save.
      extraCreditsCeiling = extraCreditsCeilingSaved;
      toasts.info(m.settings_extra_credits_ceiling_save_failed(), {
        key: "extra-credits-ceiling",
        duration: null,
        alert: true,
      });
    } finally {
      extraCreditsBusy = false;
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
        duration: null,
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
        duration: null,
        alert: true,
      });
    } finally {
      fableAvailableBusy = false;
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
        duration: null,
        alert: true,
      });
    } finally {
      usageHoldPctBusy = false;
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
      toasts.info(m.settings_housekeeping_save_failed());
    } finally {
      hkBusy = false;
    }
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
      defaultModel = s.defaultModel;
      defaultModelSaved = s.defaultModel;
      authMode = s.authMode;
      authModeSaved = s.authMode;
      hasApiKey = s.hasApiKey;
      extraCreditsCeiling = s.extraCreditsDrainCeiling;
      extraCreditsCeilingSaved = s.extraCreditsDrainCeiling;
      usageHoldEnabled = s.usageHoldEnabled;
      usageHoldPct = s.usageHoldPct;
      usageHoldPctSaved = s.usageHoldPct;
      fableAvailable = s.fableAvailable;
    } catch {
      // settings load failed — session fields keep their defaults
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
      <SettingsWorkspacePanel {onclone} {onfork} {onsaved} {onclose} />
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
        <span class="micro">{m.settings_default_model_title()}</span>
        <p class="hint">{m.settings_default_model_hint()}</p>
        <select
          class="model-select"
          bind:value={defaultModel}
          disabled={defaultModelBusy}
          aria-label={m.settings_default_model_title()}
          onchange={saveDefaultModel}
        >
          <option value="auto">{m.settings_default_model_auto()}</option>
          <option value="default">{m.newtask_model_default()}</option>
          {#each MODELS as mdl (mdl)}
            <option value={mdl}>{modelLabel(mdl)}</option>
          {/each}
        </select>
        {#if isPremiumModel}
          <p class="premium-warn">{m.settings_default_model_premium_warning()}</p>
        {/if}
        {#if is1mModel}
          <p class="premium-warn">{m.settings_default_model_1m_note()}</p>
        {/if}
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
      <div bind:this={steersEl}><SteersEditor /></div>
    </div>

    <div
      class="panel"
      role="tabpanel"
      id="settings-panel-device"
      aria-labelledby="settings-tab-device"
      tabindex="0"
      hidden={tab !== "device"}
    >
      <SettingsDevicePanel {onwhatsnew} />
    </div>

    <div
      class="panel"
      role="tabpanel"
      id="settings-panel-diagnose"
      aria-labelledby="settings-tab-diagnose"
      tabindex="0"
      hidden={tab !== "diagnose"}
    >
      <SettingsDiagnosePanel {initialDiagnostics} />
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
  .rc {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .rc .hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0;
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
