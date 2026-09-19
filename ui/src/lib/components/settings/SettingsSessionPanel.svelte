<script lang="ts">
  import { untrack } from "svelte";
  import {
    putRemoteControl,
    putSessionHousekeeping,
    putAutoRevive,
    putPrReviewCyclesCap,
    putPlanReviewCyclesCap,
    putExtraCreditsDrainCeiling,
    putUsageHoldEnabled,
    putUsageHoldPct,
    putUsageDowngradeEnabled,
    putUsageDowngradePct,
    putUsageDowngradeModel,
    putTelemetryConsent,
    putTuiFullscreen,
    putTuiDisableMouse,
    putJudgeEnabled,
    putJudgeDailyUsd,
    putBlockJudgeMode,
    logout,
  } from "$lib/api";
  import { MODELS, type Settings } from "$lib/types";
  import { modelGuidanceAlias, modelOptionLabel } from "$lib/model-guidance";
  import ModelGuidance from "$lib/components/ModelGuidance.svelte";
  import RestartShepherdDialog from "$lib/components/RestartShepherdDialog.svelte";
  import { relativeAge } from "$lib/format";
  import SettingRow from "./SettingRow.svelte";
  import SettingToggle from "./SettingToggle.svelte";
  import "./settings-controls.css";
  import { toasts } from "$lib/toasts.svelte";
  import { m } from "$lib/paraglide/messages";

  // The Session section rebuilt to the 5a/5b aligned-row pattern. Owns all
  // session-scoped state, seeded once from the parent's single getSettings()
  // payload — EXCEPT fableAvailable, which is shared with the Coding CLI
  // section's guidance and therefore lives in Settings.svelte.
  let {
    payload,
    query = "",
    fableAvailable,
    fableAvailableBusy,
    onToggleFable,
  }: {
    payload: Settings | null;
    query?: string;
    fableAvailable: boolean;
    fableAvailableBusy: boolean;
    onToggleFable: () => void;
  } = $props();

  let remoteControl = $state(false); // Claude Code Remote Control auto-start in sessions
  let rcBusy = $state(false);
  let restartOpen = $state(false); // the Restart-Shepherd confirm dialog
  let telemetryOn = $state(false);
  let telemetryAvailable = $state(false);
  let telemetryBusy = $state(false);
  let telemetryHealth = $state<Settings["telemetryHealth"]>(null);
  // Newest attempt wins: an error after the last success means the pipeline is dropping events.
  const telemetryFailing = $derived(
    !!telemetryHealth?.lastErrorAt &&
      (telemetryHealth.lastSentAt === null ||
        telemetryHealth.lastErrorAt > telemetryHealth.lastSentAt),
  );
  // Ages are resolved when the payload is seeded, not on a ticking clock — this line is a
  // health check the operator reads on open, not a live counter.
  const telemetryHealthLine = $derived.by(() => {
    const h = telemetryHealth;
    if (!h) return "";
    const now = Date.now();
    if (telemetryFailing && h.lastErrorAt !== null) {
      return m.settings_telemetry_health_failed({
        age: relativeAge(h.lastErrorAt, now),
        reason: h.lastError ?? "",
      });
    }
    if (h.lastSentAt !== null)
      return m.settings_telemetry_health_sent({ age: relativeAge(h.lastSentAt, now) });
    return m.settings_telemetry_health_never();
  });
  let housekeeping = $state(true); // daily prune of old archived sessions (kill switch)
  let hkBusy = $state(false);
  let autoRevive = $state(false); // auto-revive stranded sessions after a herdr restart
  let arBusy = $state(false);
  let retentionDays = $state(30); // display-only, from the settings payload
  let retentionKeep = $state(250); // display-only, from the settings payload
  let prReviewCycles = $state(3);
  let prReviewCyclesMin = $state(1);
  let prReviewCyclesMax = $state(8);
  let prReviewCyclesSaved = 3;
  let prRcyBusy = $state(false);
  let planReviewCycles = $state(5);
  let planReviewCyclesMin = $state(1);
  let planReviewCyclesMax = $state(12);
  let planReviewCyclesSaved = 5;
  let planRcyBusy = $state(false);
  let extraCreditsCeiling = $state(0); // account-wide extra-credit spend ceiling (0 = pause on any)
  let extraCreditsCeilingSaved = 0;
  let extraCreditsBusy = $state(false);
  let usageHoldEnabled = $state(true);
  let usageHoldBusy = $state(false);
  let usageHoldPct = $state(80);
  let usageHoldPctSaved = 80;
  let usageHoldPctBusy = $state(false);
  let usageDowngradeEnabled = $state(false);
  let usageDowngradeBusy = $state(false);
  let usageDowngradePct = $state(70);
  let usageDowngradePctSaved = 70;
  let usageDowngradePctBusy = $state(false);
  let usageDowngradeModel = $state("haiku");
  let usageDowngradeModelSaved = "haiku";
  let usageDowngradeModelBusy = $state(false);
  let tuiFullscreen = $state(false);
  let tuiFullscreenBusy = $state(false);
  let tuiDisableMouse = $state(false);
  let tuiDisableMouseBusy = $state(false);
  let judgeEnabled = $state(false);
  let judgeHasKey = $state(false);
  let judgeBusy = $state(false);
  let judgeDailyUsd = $state(1);
  let judgeDailyUsdSaved = 1;
  let judgeDailyUsdBusy = $state(false);
  let blockJudgeMode = $state<"off" | "shadow" | "armed">("off");
  let blockJudgeModeSaved: "off" | "shadow" | "armed" = "off";
  let blockJudgeBusy = $state(false);

  // Seed once from the parent's single getSettings() payload; server-seed
  // fallbacks keep controls sensible against an older backend.
  let seeded = false;
  $effect(() => {
    if (!payload || seeded) return;
    seeded = true;
    const s = payload;
    untrack(() => {
      remoteControl = s.remoteControlAtStartup;
      housekeeping = s.sessionHousekeepingEnabled;
      autoRevive = s.autoReviveEnabled;
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
      extraCreditsCeiling = s.extraCreditsDrainCeiling;
      extraCreditsCeilingSaved = s.extraCreditsDrainCeiling;
      usageHoldEnabled = s.usageHoldEnabled;
      usageHoldPct = s.usageHoldPct;
      usageHoldPctSaved = s.usageHoldPct;
      usageDowngradeEnabled = s.usageDowngradeEnabled ?? false;
      usageDowngradePct = s.usageDowngradePct ?? 70;
      usageDowngradePctSaved = usageDowngradePct;
      usageDowngradeModel = s.usageDowngradeModel ?? "haiku";
      usageDowngradeModelSaved = usageDowngradeModel;
      tuiFullscreen = s.tuiFullscreen;
      tuiDisableMouse = s.tuiDisableMouse;
      judgeEnabled = s.judgeEnabled ?? false;
      judgeHasKey = s.judgeHasKey ?? false;
      judgeDailyUsd = s.judgeDailyUsd ?? 1;
      judgeDailyUsdSaved = judgeDailyUsd;
      blockJudgeMode = s.blockJudgeMode ?? "off";
      blockJudgeModeSaved = blockJudgeMode;
      telemetryOn = s.telemetryConsent === "granted";
      telemetryAvailable = s.telemetryAvailable;
      telemetryHealth = s.telemetryHealth;
    });
  });

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
      // the switch stays in its prior position (state only advances on
      // success); surface the failure so the no-op isn't silent.
      toasts.info(m.settings_housekeeping_save_failed(), {
        alert: true,
        key: "session-housekeeping",
      });
    } finally {
      hkBusy = false;
    }
  }

  async function toggleAutoRevive() {
    if (arBusy) return;
    arBusy = true;
    const next = !autoRevive;
    try {
      const s = await putAutoRevive(next);
      autoRevive = s.autoReviveEnabled;
    } catch {
      toasts.info(m.settings_auto_revive_save_failed(), { alert: true, key: "auto-revive" });
    } finally {
      arBusy = false;
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

  async function savePrReviewCycles() {
    if (prRcyBusy) return;
    prRcyBusy = true;
    // Clamp client-side to the server bounds before sending (the server clamps
    // too); an empty/NaN field falls back to the minimum rather than posting garbage.
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
      planReviewCycles = planReviewCyclesSaved;
      toasts.info(m.settings_plan_review_cycles_save_failed(), {
        key: "plan-review-cycles-cap",
        alert: true,
      });
    } finally {
      planRcyBusy = false;
    }
  }

  async function saveExtraCreditsCeiling() {
    if (extraCreditsBusy) return;
    extraCreditsBusy = true;
    const n = Number(extraCreditsCeiling);
    const clamped = Number.isFinite(n) && n >= 0 ? n : 0;
    extraCreditsCeiling = clamped;
    try {
      const r = await putExtraCreditsDrainCeiling(clamped);
      extraCreditsCeiling = r.extraCreditsDrainCeiling;
      extraCreditsCeilingSaved = r.extraCreditsDrainCeiling;
    } catch {
      extraCreditsCeiling = extraCreditsCeilingSaved;
      toasts.info(m.settings_extra_credits_ceiling_save_failed(), {
        key: "extra-credits-ceiling",
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
        alert: true,
      });
    } finally {
      usageHoldBusy = false;
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

  async function toggleJudge() {
    if (judgeBusy) return;
    judgeBusy = true;
    try {
      const r = await putJudgeEnabled(!judgeEnabled);
      judgeEnabled = r.judgeEnabled;
    } catch {
      toasts.info(m.settings_judge_save_failed(), { key: "judge-enabled", alert: true });
    } finally {
      judgeBusy = false;
    }
  }

  async function saveJudgeDailyUsd() {
    if (judgeDailyUsdBusy) return;
    judgeDailyUsdBusy = true;
    const n = Number(judgeDailyUsd);
    const clamped = Number.isFinite(n) ? Math.min(1000, Math.max(0, n)) : judgeDailyUsdSaved;
    judgeDailyUsd = clamped;
    try {
      const r = await putJudgeDailyUsd(clamped);
      judgeDailyUsd = r.judgeDailyUsd;
      judgeDailyUsdSaved = r.judgeDailyUsd;
    } catch {
      judgeDailyUsd = judgeDailyUsdSaved;
      toasts.info(m.settings_judge_daily_usd_save_failed(), {
        key: "judge-daily-usd",
        alert: true,
      });
    } finally {
      judgeDailyUsdBusy = false;
    }
  }

  async function saveBlockJudgeMode() {
    if (blockJudgeBusy) return;
    blockJudgeBusy = true;
    try {
      const r = await putBlockJudgeMode(blockJudgeMode);
      blockJudgeMode = r.blockJudgeMode;
      blockJudgeModeSaved = r.blockJudgeMode;
    } catch {
      blockJudgeMode = blockJudgeModeSaved;
      toasts.info(m.settings_block_judge_save_failed(), { key: "block-judge", alert: true });
    } finally {
      blockJudgeBusy = false;
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
</script>

<SettingRow
  title={m.settings_remote_control_title()}
  description={m.settings_remote_control_hint()}
  {query}
  inlineOnMobile
  onrowclick={toggleRemoteControl}
>
  {#snippet control()}
    <SettingToggle
      checked={remoteControl}
      disabled={rcBusy}
      label={m.settings_remote_control_title()}
      onchange={toggleRemoteControl}
    />
  {/snippet}
</SettingRow>

<!-- No onrowclick (#2331): the sweep is a silent daily background job, so a stray click on
     this row's text would either delete archived sessions (and their cascaded review rows)
     for good or quietly stop pruning, with nothing anywhere to show it happened. The
     toggle is the only hit target. -->
<SettingRow
  title={m.settings_housekeeping_title()}
  description={m.settings_housekeeping_hint({ days: retentionDays, count: retentionKeep })}
  {query}
  inlineOnMobile
>
  {#snippet control()}
    <SettingToggle
      checked={housekeeping}
      disabled={hkBusy}
      label={m.settings_housekeeping_title()}
      onchange={toggleHousekeeping}
    />
  {/snippet}
</SettingRow>

<SettingRow
  title={m.settings_auto_revive_title()}
  description={m.settings_auto_revive_hint()}
  {query}
  inlineOnMobile
  onrowclick={toggleAutoRevive}
>
  {#snippet control()}
    <SettingToggle
      checked={autoRevive}
      disabled={arBusy}
      label={m.settings_auto_revive_title()}
      onchange={toggleAutoRevive}
    />
  {/snippet}
</SettingRow>

<!-- No onrowclick (#2331): consent is the one setting whose flip leaves no trace — telemetry
     is fire-and-forget, so an accidental opt-out from a click on the title or the
     description text is both cheap and silent. The toggle is the only hit target. -->
<SettingRow
  title={m.settings_telemetry_title()}
  description={m.settings_telemetry_hint()}
  {query}
  inlineOnMobile={telemetryAvailable}
>
  {#snippet control()}
    {#if telemetryAvailable}
      <SettingToggle
        checked={telemetryOn}
        disabled={telemetryBusy}
        label={m.settings_telemetry_title()}
        onchange={toggleTelemetry}
      />
    {:else}
      <span class="unavailable">{m.settings_telemetry_unavailable()}</span>
    {/if}
  {/snippet}
  {#snippet below()}
    <!-- Send health, shown only under granted consent: with the toggle off there is
         nothing to report, and a stale "last sent" next to an off switch would mislead.
         Telemetry failures are swallowed by design, so this line is the only place a
         silently dropping pipeline becomes visible. It is also the one thing in the row an
         operator reads closely and copies — the failing HTTP status. -->
    {#if telemetryAvailable && telemetryOn && telemetryHealth}
      <p class="telemetry-health" class:failing={telemetryFailing} data-testid="telemetry-health">
        {telemetryHealthLine}
      </p>
    {/if}
  {/snippet}
</SettingRow>

<SettingRow
  title={m.settings_pr_review_cycles_title()}
  description={m.settings_pr_review_cycles_hint({
    min: prReviewCyclesMin,
    max: prReviewCyclesMax,
  })}
  {query}
>
  {#snippet control()}
    <input
      class="set-num"
      type="number"
      min={prReviewCyclesMin}
      max={prReviewCyclesMax}
      step="1"
      disabled={prRcyBusy}
      bind:value={prReviewCycles}
      aria-label={m.settings_pr_review_cycles_title()}
      onchange={savePrReviewCycles}
    />
  {/snippet}
</SettingRow>

<SettingRow
  title={m.settings_plan_review_cycles_title()}
  description={m.settings_plan_review_cycles_hint({
    min: planReviewCyclesMin,
    max: planReviewCyclesMax,
  })}
  {query}
>
  {#snippet control()}
    <input
      class="set-num"
      type="number"
      min={planReviewCyclesMin}
      max={planReviewCyclesMax}
      step="1"
      disabled={planRcyBusy}
      bind:value={planReviewCycles}
      aria-label={m.settings_plan_review_cycles_title()}
      onchange={savePlanReviewCycles}
    />
  {/snippet}
</SettingRow>

<SettingRow title={m.restart_title()} description={m.restart_settings_hint()} {query}>
  {#snippet control()}
    <button type="button" class="set-gbtn" onclick={() => (restartOpen = true)}>
      {m.restart_button()}
    </button>
  {/snippet}
</SettingRow>

<SettingRow title={m.settings_logout_title()} description={m.settings_logout_hint()} {query}>
  {#snippet control()}
    <button type="button" class="set-gbtn" onclick={() => logout()}>
      {m.settings_logout_button()}
    </button>
  {/snippet}
</SettingRow>

<SettingRow
  title={m.settings_extra_credits_ceiling_title()}
  description={m.settings_extra_credits_ceiling_hint()}
  {query}
>
  {#snippet control()}
    <input
      class="set-num"
      type="number"
      min="0"
      step="1"
      disabled={extraCreditsBusy}
      bind:value={extraCreditsCeiling}
      aria-label={m.settings_extra_credits_ceiling_title()}
      onchange={saveExtraCreditsCeiling}
    />
  {/snippet}
</SettingRow>

<SettingRow
  title={m.settings_usage_hold_enabled_label()}
  description={m.settings_usage_hold_hint()}
  {query}
  inlineOnMobile
  onrowclick={toggleUsageHold}
>
  {#snippet control()}
    <SettingToggle
      checked={usageHoldEnabled}
      disabled={usageHoldBusy}
      label={m.settings_usage_hold_enabled_label()}
      onchange={toggleUsageHold}
    />
  {/snippet}
</SettingRow>

<SettingRow
  title={m.settings_usage_hold_pct_label()}
  description={m.settings_usage_hold_pct_hint()}
  {query}
>
  {#snippet control()}
    <input
      class="set-num"
      type="number"
      min="0"
      max="100"
      step="1"
      disabled={usageHoldPctBusy || !usageHoldEnabled}
      bind:value={usageHoldPct}
      aria-label={m.settings_usage_hold_pct_label()}
      onchange={saveUsageHoldPct}
    />
  {/snippet}
</SettingRow>

<SettingRow
  title={m.settings_usage_downgrade_enabled_label()}
  description={m.settings_usage_downgrade_hint()}
  {query}
  inlineOnMobile
  onrowclick={toggleUsageDowngrade}
>
  {#snippet control()}
    <SettingToggle
      checked={usageDowngradeEnabled}
      disabled={usageDowngradeBusy}
      label={m.settings_usage_downgrade_enabled_label()}
      onchange={toggleUsageDowngrade}
    />
  {/snippet}
</SettingRow>

<SettingRow
  title={m.settings_usage_downgrade_pct_label()}
  description={m.settings_usage_downgrade_pct_hint()}
  {query}
>
  {#snippet control()}
    <input
      class="set-num"
      type="number"
      min="0"
      max="100"
      step="1"
      disabled={usageDowngradePctBusy || !usageDowngradeEnabled}
      bind:value={usageDowngradePct}
      aria-label={m.settings_usage_downgrade_pct_label()}
      onchange={saveUsageDowngradePct}
    />
  {/snippet}
</SettingRow>

<SettingRow
  title={m.settings_usage_downgrade_model_label()}
  description={m.settings_usage_downgrade_model_hint()}
  {query}
>
  {#snippet control()}
    <span class="set-select">
      <select
        bind:value={usageDowngradeModel}
        disabled={usageDowngradeModelBusy || !usageDowngradeEnabled}
        aria-label={m.settings_usage_downgrade_model_label()}
        onchange={saveUsageDowngradeModel}
      >
        <!-- Concrete aliases only: "auto"/"default" resolve to null (no --model)
             via drainSpawnModel, which would make the downgrade a silent no-op. -->
        {#each MODELS as mdl (mdl)}
          <option value={mdl}>{modelOptionLabel("claude", mdl)}</option>
        {/each}
      </select>
      <span class="set-chev" aria-hidden="true">▾</span>
    </span>
  {/snippet}
  {#snippet below()}
    <ModelGuidance
      metaChips
      provider="claude"
      model={modelGuidanceAlias(usageDowngradeModel, fableAvailable)}
      context="downgrade"
    />
  {/snippet}
</SettingRow>

<SettingRow
  title={m.settings_fable_available_label()}
  description={m.settings_fable_available_hint()}
  {query}
  inlineOnMobile
  onrowclick={onToggleFable}
>
  {#snippet control()}
    <SettingToggle
      checked={fableAvailable}
      disabled={fableAvailableBusy}
      label={m.settings_fable_available_label()}
      onchange={onToggleFable}
    />
  {/snippet}
</SettingRow>

<SettingRow
  title={m.settings_judge_enabled_label()}
  description={judgeHasKey ? m.settings_judge_enabled_hint() : m.settings_judge_no_key_hint()}
  {query}
  inlineOnMobile
  onrowclick={judgeHasKey ? toggleJudge : undefined}
>
  {#snippet control()}
    <SettingToggle
      checked={judgeEnabled}
      disabled={judgeBusy || !judgeHasKey}
      label={m.settings_judge_enabled_label()}
      onchange={toggleJudge}
    />
  {/snippet}
</SettingRow>

<SettingRow
  title={m.settings_judge_daily_usd_label()}
  description={m.settings_judge_daily_usd_hint()}
  {query}
>
  {#snippet control()}
    <input
      class="set-num"
      type="number"
      min="0"
      max="1000"
      step="0.5"
      disabled={judgeDailyUsdBusy || !judgeEnabled}
      bind:value={judgeDailyUsd}
      aria-label={m.settings_judge_daily_usd_label()}
      onchange={saveJudgeDailyUsd}
    />
  {/snippet}
</SettingRow>

<SettingRow
  title={m.settings_block_judge_label()}
  description={judgeHasKey ? m.settings_block_judge_hint() : m.settings_block_judge_no_key_hint()}
  {query}
>
  {#snippet control()}
    <span class="set-select">
      <select
        bind:value={blockJudgeMode}
        disabled={blockJudgeBusy || !judgeHasKey}
        aria-label={m.settings_block_judge_label()}
        onchange={saveBlockJudgeMode}
      >
        <option value="off">{m.settings_block_judge_mode_off()}</option>
        <option value="shadow">{m.settings_block_judge_mode_shadow()}</option>
        <option value="armed">{m.settings_block_judge_mode_armed()}</option>
      </select>
      <span class="set-chev" aria-hidden="true">▾</span>
    </span>
  {/snippet}
</SettingRow>

<SettingRow
  title={m.settings_tui_fullscreen_label()}
  description={m.settings_tui_fullscreen_hint()}
  {query}
  inlineOnMobile
  onrowclick={toggleTuiFullscreen}
>
  {#snippet control()}
    <SettingToggle
      checked={tuiFullscreen}
      disabled={tuiFullscreenBusy}
      label={m.settings_tui_fullscreen_label()}
      onchange={toggleTuiFullscreen}
    />
  {/snippet}
</SettingRow>

<SettingRow
  title={m.settings_tui_disable_mouse_label()}
  description={m.settings_tui_disable_mouse_hint()}
  {query}
  inlineOnMobile
  onrowclick={toggleTuiDisableMouse}
>
  {#snippet control()}
    <SettingToggle
      checked={tuiDisableMouse}
      disabled={tuiDisableMouseBusy}
      label={m.settings_tui_disable_mouse_label()}
      onchange={toggleTuiDisableMouse}
    />
  {/snippet}
</SettingRow>

{#if restartOpen}
  <RestartShepherdDialog onclose={() => (restartOpen = false)} />
{/if}

<style>
  .telemetry-health {
    margin: 6px 0 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .telemetry-health.failing {
    color: var(--color-amber);
  }

  .unavailable {
    color: var(--color-faint);
    font-size: var(--fs-meta);
  }
</style>
