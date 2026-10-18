<script lang="ts">
  import { untrack } from "svelte";
  import {
    getJudgeConnection,
    putBlockJudgeMode,
    putJudgeConnection,
    putJudgeDailyUsd,
    putJudgeEnabled,
    putUpNextReadiness,
  } from "#lib/api.js";
  import {
    DECISION_MODEL_FEATURE_COUNT,
    activeFeatureCount,
    decisionModelState,
    decisionModelSummary,
    formatUsd,
    keyRejection,
  } from "#lib/decision-model.js";
  import { formatAgo } from "#lib/format.js";
  import { decisionModelRows, matchCount } from "#lib/settings-search.js";
  import {
    blockBackstopExplanation,
    stopClassifierExplanation,
    upNextReadinessExplanation,
  } from "#lib/tooltips/explanations.js";
  import type { JudgeConnectionError, JudgeConnectionStatus, Settings } from "#lib/types.js";
  import DecisionModelKeyBlock from "./DecisionModelKeyBlock.svelte";
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

  let modelDraft = $state("");
  let baseUrlDraft = $state("");
  let timeoutDraft = $state(8000);
  let baseUrlKey = $state("");
  let fieldBusy = $state(false);
  let fieldError = $state<{ field: string; text: string } | null>(null);

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

  /** Take a fresh status, and reset the Advanced drafts to what is now in force. */
  function adopt(s: JudgeConnectionStatus) {
    connection = s;
    modelDraft = s.model === s.defaults.model ? "" : s.model;
    baseUrlDraft = s.baseUrl === s.defaults.baseUrl ? "" : s.baseUrl;
    timeoutDraft = s.timeoutMs;
    baseUrlKey = "";
  }

  const features = $derived({ judgeEnabled, upNextReadiness, blockJudgeMode });
  const dmState = $derived(decisionModelState(connection, features));
  const hasKey = $derived(
    connection ? connection.keySource !== "none" : (payload?.judgeHasKey ?? false),
  );
  const judgeArmed = $derived(judgeEnabled && hasKey);
  const onCount = $derived(activeFeatureCount(features));

  $effect(() => {
    onsummary?.(decisionModelSummary(connection, features));
  });

  const connExpanded = $derived(
    connOpen || (q !== "" && matchCount([...rows.connection, ...rows.advanced], q) > 0),
  );
  const advancedExpanded = $derived(advancedOpen || (q !== "" && matchCount(rows.advanced, q) > 0));
  const usesExpanded = $derived(usesOpen || (q !== "" && matchCount(rows.uses, q) > 0));

  function stateLabel(): string {
    switch (dmState) {
      case "notConnected":
        return m.settings_dm_state_not_connected();
      case "ready":
        return m.settings_dm_state_ready();
      case "active":
        return m.settings_dm_state_active();
      case "limitReached":
        return m.settings_dm_state_limit();
      case "keyRejected":
        return m.settings_dm_state_rejected();
    }
  }

  function stateHint(): string {
    const s = connection;
    switch (dmState) {
      case "notConnected":
        return m.settings_dm_state_not_connected_hint();
      case "ready":
        return m.settings_dm_state_ready_hint();
      case "active": {
        const line = m.settings_dm_state_active_hint({
          count: onCount,
          total: DECISION_MODEL_FEATURE_COUNT,
          model: s?.model ?? "",
        });
        return s?.lastOkAt
          ? `${line} · ${m.settings_dm_state_last_answer({ age: formatAgo(Date.now() - s.lastOkAt) })}`
          : line;
      }
      case "limitReached":
        return m.settings_dm_state_limit_hint();
      case "keyRejected": {
        const r = s ? keyRejection(s) : null;
        return m.settings_dm_state_rejected_hint({
          status: String(r?.status ?? "—"),
          time: r ? new Date(r.at).toLocaleTimeString(undefined, { timeStyle: "short" }) : "—",
        });
      }
    }
  }

  const spendPct = $derived.by(() => {
    const t = connection?.today;
    if (!t) return 0;
    if (t.ceilingUsd <= 0) return 100;
    return Math.min(100, Math.round((t.usd / t.ceilingUsd) * 100));
  });

  function envName(field: "model" | "baseUrl" | "timeoutMs"): string {
    if (field === "model") return "SHEPHERD_JUDGE_MODEL";
    if (field === "baseUrl") return "SHEPHERD_JUDGE_BASE_URL";
    return "SHEPHERD_JUDGE_TIMEOUT_MS";
  }

  function fieldErrorText(e: JudgeConnectionError): string {
    switch (e.error) {
      case "model_invalid":
        return m.settings_dm_err_model();
      case "base_url_invalid":
        return m.settings_dm_err_base_url();
      case "timeout_invalid":
        return m.settings_dm_err_timeout();
      case "key_required":
        return m.settings_dm_err_key_required();
      case "key_rejected":
        return m.settings_dm_key_rejected({ status: String(e.status ?? "—") });
      case "unreachable":
        return m.settings_dm_key_unreachable({ host: hostOf(baseUrlDraft) });
      case "key_invalid":
        return m.settings_dm_key_invalid();
      case "env_locked":
        return m.settings_dm_env_locked({
          name: e.field === "key" ? "JEV_API_KEY" : envName(e.field),
        });
    }
  }

  function hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  async function saveFields(
    field: "model" | "baseUrl" | "timeoutMs",
    body: Parameters<typeof putJudgeConnection>[0],
  ) {
    if (fieldBusy) return;
    fieldBusy = true;
    fieldError = null;
    try {
      const r = await putJudgeConnection(body);
      if ("error" in r) fieldError = { field, text: fieldErrorText(r) };
      else adopt(r);
    } catch {
      fieldError = { field, text: m.settings_dm_save_failed() };
    } finally {
      baseUrlKey = "";
      fieldBusy = false;
    }
  }

  function draftMatchesBaseUrl(): boolean {
    const s = connection;
    if (!s) return true;
    const draft = baseUrlDraft.trim().replace(/\/+$/, "") || s.defaults.baseUrl;
    return draft === s.baseUrl;
  }
  // Moving the address away from a stored key needs the key again — the server refuses otherwise,
  // so the form asks for it up front instead of after a failed save.
  const baseUrlNeedsKey = $derived(connection?.keySource === "stored" && !draftMatchesBaseUrl());
  const baseUrlLocked = $derived(!!connection && (connection.env.baseUrl || connection.env.key));

  function saveBaseUrl() {
    if (baseUrlNeedsKey || draftMatchesBaseUrl()) return;
    void saveFields("baseUrl", { baseUrl: baseUrlDraft });
  }

  function saveBaseUrlWithKey(e: SubmitEvent) {
    e.preventDefault();
    if (!baseUrlKey.trim()) return;
    void saveFields("baseUrl", { baseUrl: baseUrlDraft, key: baseUrlKey.trim() });
  }

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

<section class="dm-status" data-state={dmState} aria-label={m.settings_dm_status_aria()}>
  <span class="dot" aria-hidden="true"></span>
  <div class="dm-status-text">
    <span class="dm-state">{stateLabel()}</span>
    <span class="dm-state-hint">{stateHint()}</span>
  </div>
  {#if connection?.today && dmState !== "notConnected"}
    <div class="dm-spend">
      <div class="dm-spend-line">
        <span class="dm-today">{m.settings_dm_today()}</span>
        <span class="dm-usd"
          >{formatUsd(connection.today.usd)} / {formatUsd(connection.today.ceilingUsd)}</span
        >
      </div>
      <div class="dm-bar" role="img" aria-label={m.settings_dm_spend_aria({ pct: spendPct })}>
        <div class="dm-bar-fill" style:width={`${spendPct}%`}></div>
      </div>
    </div>
  {/if}
</section>
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
    <SettingsGroup
      label={m.settings_dm_group_advanced()}
      count={rows.advanced.length}
      expanded={advancedExpanded}
      ontoggle={() => (advancedOpen = !advancedExpanded)}
    >
      <SettingRow
        title={m.settings_dm_model_title()}
        description={m.settings_dm_model_hint()}
        {query}
      >
        {#snippet control()}
          <input
            class="set-txt"
            type="text"
            list="dm-models"
            spellcheck="false"
            autocomplete="off"
            placeholder={connection?.defaults.model}
            aria-label={m.settings_dm_model_title()}
            disabled={!connection || connection.env.model || fieldBusy}
            bind:value={modelDraft}
            onchange={() => void saveFields("model", { model: modelDraft })}
          />
          <datalist id="dm-models">
            {#each connection?.models ?? [] as name (name)}<option value={name}></option>{/each}
          </datalist>
        {/snippet}
        {#snippet below()}
          {#if connection?.env.model}
            <p class="dm-note">{m.settings_dm_env_locked({ name: envName("model") })}</p>
          {:else if fieldError?.field === "model"}
            <p class="dm-note err" role="alert">{fieldError.text}</p>
          {/if}
        {/snippet}
      </SettingRow>

      <SettingRow
        title={m.settings_dm_base_url_title()}
        description={m.settings_dm_base_url_hint()}
        {query}
      >
        {#snippet control()}
          <input
            class="set-txt"
            type="url"
            spellcheck="false"
            autocomplete="off"
            placeholder={connection?.defaults.baseUrl}
            aria-label={m.settings_dm_base_url_title()}
            disabled={!connection || baseUrlLocked || fieldBusy}
            bind:value={baseUrlDraft}
            onchange={saveBaseUrl}
          />
        {/snippet}
        {#snippet below()}
          {#if connection?.env.key}
            <p class="dm-note">{m.settings_dm_base_url_env_key()}</p>
          {:else if connection?.env.baseUrl}
            <p class="dm-note">{m.settings_dm_env_locked({ name: envName("baseUrl") })}</p>
          {:else if baseUrlNeedsKey}
            <form class="dm-rekey" onsubmit={saveBaseUrlWithKey}>
              <input
                class="set-txt"
                type="password"
                autocomplete="off"
                spellcheck="false"
                placeholder={m.settings_dm_key_placeholder()}
                aria-label={m.settings_dm_base_url_key_label()}
                disabled={fieldBusy}
                bind:value={baseUrlKey}
              />
              <button type="submit" class="set-run" disabled={fieldBusy || !baseUrlKey.trim()}
                >{fieldBusy ? m.settings_dm_key_verifying() : m.settings_dm_base_url_save()}</button
              >
            </form>
          {/if}
          {#if fieldError?.field === "baseUrl"}
            <p class="dm-note err" role="alert">{fieldError.text}</p>
          {/if}
        {/snippet}
      </SettingRow>

      <SettingRow
        title={m.settings_dm_timeout_title()}
        description={m.settings_dm_timeout_hint()}
        {query}
      >
        {#snippet control()}
          <span class="dm-unit-field">
            <input
              class="set-num"
              type="number"
              min="1000"
              max="60000"
              step="500"
              aria-label={m.settings_dm_timeout_title()}
              disabled={!connection || connection.env.timeoutMs || fieldBusy}
              bind:value={timeoutDraft}
              onchange={() => void saveFields("timeoutMs", { timeoutMs: Number(timeoutDraft) })}
            />
            <span class="dm-unit">{m.settings_dm_ms_unit()}</span>
          </span>
        {/snippet}
        {#snippet below()}
          {#if connection?.env.timeoutMs}
            <p class="dm-note">{m.settings_dm_env_locked({ name: envName("timeoutMs") })}</p>
          {:else if fieldError?.field === "timeoutMs"}
            <p class="dm-note err" role="alert">{fieldError.text}</p>
          {/if}
        {/snippet}
      </SettingRow>
    </SettingsGroup>
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
  .dm-status {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 14px;
    margin-bottom: 18px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    border: 1px solid var(--color-faint);
  }
  .dm-status-text {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
    min-width: 0;
  }
  .dm-state {
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .dm-state-hint {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.5;
  }
  [data-state="ready"] .dot {
    border-color: var(--color-ink-bright);
  }
  [data-state="ready"] .dm-state {
    color: var(--color-ink-bright);
  }
  [data-state="active"] .dot {
    background: var(--color-amber);
    border-color: var(--color-amber);
  }
  [data-state="active"] .dm-state {
    color: var(--color-amber);
  }
  [data-state="limitReached"] {
    border-color: var(--color-warn);
  }
  [data-state="limitReached"] .dot {
    background: var(--color-warn);
    border-color: var(--color-warn);
  }
  [data-state="limitReached"] .dm-state,
  [data-state="limitReached"] .dm-usd {
    color: var(--color-warn);
  }
  [data-state="keyRejected"] {
    border-color: var(--color-red);
  }
  [data-state="keyRejected"] .dot {
    background: var(--color-red);
    border-color: var(--color-red);
  }
  [data-state="keyRejected"] .dm-state {
    color: var(--color-red);
  }
  [data-state="limitReached"] .dm-state-hint,
  [data-state="keyRejected"] .dm-state-hint {
    color: var(--color-ink);
  }
  .dm-spend {
    display: flex;
    flex-direction: column;
    gap: 5px;
    width: 170px;
    flex-shrink: 0;
  }
  .dm-spend-line {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .dm-today {
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .dm-usd {
    margin-left: auto;
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    font-variant-numeric: tabular-nums;
  }
  .dm-bar {
    height: 4px;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
  }
  .dm-bar-fill {
    height: 100%;
    background: var(--color-amber);
  }
  [data-state="limitReached"] .dm-bar-fill {
    background: var(--color-warn);
  }
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
  .dm-rekey {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .dm-rekey .set-txt {
    flex: 1;
    min-width: 12em;
    width: auto;
  }
  .dm-unit-field {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .dm-unit {
    font-size: var(--fs-meta);
    color: var(--color-muted);
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
    .dm-status {
      flex-wrap: wrap;
    }
    .dm-spend {
      width: 100%;
    }
    .dm-sub {
      padding-left: 10px;
    }
    .dm-nested {
      margin-left: 4px;
      padding-left: 12px;
    }
    .dm-note,
    .dm-state-hint,
    .dm-footer {
      font-size: var(--fs-base);
    }
    .dm-link {
      min-height: 44px;
    }
  }
</style>
