<script lang="ts">
  import { untrack } from "svelte";
  import {
    getJudgeConnection,
    putBlockJudgeMode,
    putJudgeDailyUsd,
    putJudgeEnabled,
    putUpNextReadiness,
  } from "#lib/api.js";
  import { DECISION_MODEL_FEATURE_COUNT, decisionModelSummary } from "#lib/decision-model.js";
  import { decisionModelRows, matchCount } from "#lib/settings-search.js";
  import {
    blockBackstopExplanation,
    stopClassifierExplanation,
    upNextReadinessExplanation,
  } from "#lib/tooltips/explanations.js";
  import type { JudgeConnectionStatus, Settings } from "#lib/types.js";
  import DecisionModelAdvanced from "./DecisionModelAdvanced.svelte";
  import DecisionModelKeyBlock from "./DecisionModelKeyBlock.svelte";
  import DecisionModelStatus from "./DecisionModelStatus.svelte";
  import SettingRow from "./SettingRow.svelte";
  import SettingsGroup from "./SettingsGroup.svelte";
  import SettingToggle from "./SettingToggle.svelte";
  import "./settings-controls.css";
  import { toasts } from "#lib/toasts.svelte.js";
  import { m } from "#lib/paraglide/messages.js";

  // Settings → Decision model (#3071): the JEV connection (key, daily limit, and under Advanced
  // model, base URL and timeout) and the features that use it, grouped with what each one needs.
  // The connection comes from GET /api/judge/connection — loaded when the dialog opens, so the
  // mobile section list can summarise it, and again whenever the section is shown; the feature
  // switches are ordinary settings seeded from the parent's payload.
  let {
    payload,
    query = "",
    active = false,
    onsummary,
    onopenusage,
  }: {
    payload: Settings | null;
    query?: string;
    /** This section is the one on screen — refresh, since spend and key health move. */
    active?: boolean;
    /** Reports the mobile section list's line for this section whenever it changes. */
    onsummary?: (summary: string) => void;
    onopenusage?: () => void;
  } = $props();

  const rows = decisionModelRows();
  const q = $derived(query.trim().toLowerCase());

  let connection = $state<JudgeConnectionStatus | null>(null);
  let loadFailed = $state(false);

  let judgeEnabled = $state(false);
  let judgeBusy = $state(false);
  let judgeDailyUsd = $state(1);
  let judgeDailyUsdSaved = 1;
  let judgeDailyUsdBusy = $state(false);
  let blockJudgeMode = $state<"off" | "shadow" | "armed">("off");
  let blockJudgeModeSaved: "off" | "shadow" | "armed" = "off";
  let blockJudgeBusy = $state(false);
  let upNextReadiness = $state(false);
  let upNextReadinessBusy = $state(false);

  let connOpen = $state(true);
  let advancedOpen = $state(false);
  let usesOpen = $state(true);

  // Seed the switches once from the parent's single getSettings() payload.
  let seeded = false;
  $effect(() => {
    if (!payload || seeded) return;
    seeded = true;
    const s = payload;
    untrack(() => {
      judgeEnabled = s.judgeEnabled ?? false;
      judgeDailyUsd = s.judgeDailyUsd ?? 1;
      judgeDailyUsdSaved = judgeDailyUsd;
      blockJudgeMode = s.blockJudgeMode ?? "off";
      blockJudgeModeSaved = blockJudgeMode;
      upNextReadiness = s.upNextReadiness ?? false;
    });
  });

  // Loaded on mount and every time the section comes into view. Tracks `active` alone: reading the
  // status here would re-run the load after every load.
  let loaded = false;
  $effect(() => {
    const shown = active;
    untrack(() => {
      if (!shown && loaded) return;
      loaded = true;
      void load();
    });
  });

  async function load() {
    try {
      adopt(await getJudgeConnection());
      loadFailed = false;
    } catch {
      loadFailed = true;
    }
  }

  /** Take a fresh status; the Advanced fields reset their drafts from it. */
  function adopt(s: JudgeConnectionStatus) {
    connection = s;
  }

  const features = $derived({ judgeEnabled, upNextReadiness, blockJudgeMode });
  const hasKey = $derived(
    connection ? connection.keySource !== "none" : (payload?.judgeHasKey ?? false),
  );
  const judgeArmed = $derived(judgeEnabled && hasKey);

  $effect(() => {
    onsummary?.(decisionModelSummary(connection, features));
  });

  const connExpanded = $derived(
    connOpen || (q !== "" && matchCount([...rows.connection, ...rows.advanced], q) > 0),
  );
  const advancedExpanded = $derived(advancedOpen || (q !== "" && matchCount(rows.advanced, q) > 0));
  const usesExpanded = $derived(usesOpen || (q !== "" && matchCount(rows.uses, q) > 0));

  async function toggleJudge() {
    if (judgeBusy || !hasKey) return;
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
      void load(); // the strip compares today's spend with the new ceiling
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

  async function toggleUpNextReadiness() {
    if (upNextReadinessBusy || !judgeArmed) return;
    upNextReadinessBusy = true;
    try {
      const r = await putUpNextReadiness(!upNextReadiness);
      upNextReadiness = r.upNextReadiness;
    } catch {
      toasts.info(m.settings_up_next_readiness_save_failed(), {
        key: "up-next-readiness",
        alert: true,
      });
    } finally {
      upNextReadinessBusy = false;
    }
  }
</script>

<DecisionModelStatus {connection} {features} />
{#if loadFailed}<p class="dm-note err" role="alert">{m.settings_dm_load_failed()}</p>{/if}

<SettingsGroup
  label={m.settings_dm_group_connection()}
  count={rows.connection.length + rows.advanced.length}
  expanded={connExpanded}
  ontoggle={() => (connOpen = !connExpanded)}
>
  <SettingRow title={m.settings_dm_key_title()} description={m.settings_dm_key_hint()} {query}>
    {#snippet below()}
      {#if connection}
        <DecisionModelKeyBlock status={connection} onchange={adopt} />
      {/if}
    {/snippet}
  </SettingRow>

  <SettingRow
    title={m.settings_judge_daily_usd_label()}
    description={m.settings_judge_daily_usd_hint()}
    {query}
  >
    {#snippet control()}
      <span class="dm-unit-field">
        <input
          class="set-num"
          type="number"
          min="0"
          max="1000"
          step="0.5"
          disabled={judgeDailyUsdBusy}
          bind:value={judgeDailyUsd}
          aria-label={m.settings_judge_daily_usd_label()}
          onchange={saveJudgeDailyUsd}
        />
        <span class="dm-unit">{m.settings_dm_usd_unit()}</span>
      </span>
    {/snippet}
  </SettingRow>

  <div class="dm-sub">
    <DecisionModelAdvanced
      status={connection}
      {query}
      count={rows.advanced.length}
      expanded={advancedExpanded}
      ontoggle={() => (advancedOpen = !advancedExpanded)}
      onchange={adopt}
    />
  </div>
</SettingsGroup>

<SettingsGroup
  label={m.settings_dm_group_uses()}
  count={DECISION_MODEL_FEATURE_COUNT}
  expanded={usesExpanded}
  ontoggle={() => (usesOpen = !usesExpanded)}
>
  <SettingRow
    title={m.settings_judge_enabled_label()}
    description={hasKey ? m.settings_judge_enabled_hint() : m.settings_judge_no_key_hint()}
    explanation={stopClassifierExplanation()}
    {query}
    inlineOnMobile
    onrowclick={hasKey ? toggleJudge : undefined}
  >
    {#snippet control()}
      <SettingToggle
        checked={judgeEnabled}
        disabled={judgeBusy || !hasKey}
        label={m.settings_judge_enabled_label()}
        onchange={toggleJudge}
      />
    {/snippet}
  </SettingRow>

  <div class="dm-nested">
    <SettingRow
      title={m.settings_up_next_readiness_label()}
      description={judgeArmed
        ? m.settings_up_next_readiness_hint()
        : m.settings_up_next_readiness_no_key_hint()}
      explanation={upNextReadinessExplanation()}
      chip={m.settings_dm_chip_needs_classifier()}
      {query}
      inlineOnMobile
      onrowclick={judgeArmed ? toggleUpNextReadiness : undefined}
    >
      {#snippet control()}
        <SettingToggle
          checked={upNextReadiness}
          disabled={upNextReadinessBusy || !judgeArmed}
          label={m.settings_up_next_readiness_label()}
          onchange={toggleUpNextReadiness}
        />
      {/snippet}
    </SettingRow>
    <p class="dm-note dm-rides">{m.settings_dm_rides_along()}</p>
  </div>

  <SettingRow
    title={m.settings_block_judge_label()}
    description={hasKey ? m.settings_block_judge_hint() : m.settings_block_judge_no_key_hint()}
    explanation={blockBackstopExplanation()}
    chip={m.settings_dm_chip_independent()}
    {query}
  >
    {#snippet control()}
      <span class="set-select">
        <select
          bind:value={blockJudgeMode}
          disabled={blockJudgeBusy || !hasKey}
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
</SettingsGroup>

<p class="dm-footer">
  {m.settings_dm_footer()}
  {#if onopenusage}
    <button type="button" class="dm-link" onclick={onopenusage}
      >{m.settings_dm_footer_link()}</button
    >
  {/if}
</p>

<style>
  .dm-sub {
    border-top: 1px solid var(--color-line);
    padding-left: 18px;
  }
  .dm-nested {
    margin-left: 10px;
    padding-left: 16px;
    border-left: 1px dashed var(--color-line-bright);
  }
  .dm-note {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.5;
  }
  .dm-note.err {
    color: var(--color-red);
  }
  .dm-rides {
    padding: 0 0 12px;
  }
  .dm-footer {
    margin: 18px 0 0;
    padding-top: 12px;
    border-top: 1px solid var(--color-line);
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.5;
  }
  .dm-link {
    background: transparent;
    border: 0;
    padding: 0;
    font: inherit;
    color: var(--color-amber);
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .dm-link:focus-visible {
    outline: 1px solid var(--color-line-bright);
    outline-offset: 2px;
  }

  @media (max-width: 768px) {
    .dm-sub {
      padding-left: 10px;
    }
    .dm-nested {
      margin-left: 4px;
      padding-left: 12px;
    }
    .dm-note,
    .dm-footer {
      font-size: var(--fs-base);
    }
    .dm-link {
      min-height: 44px;
    }
  }
</style>
