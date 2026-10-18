<script lang="ts">
  import { untrack } from "svelte";
  import { putJudgeConnection } from "#lib/api.js";
  import type { JudgeConnectionError, JudgeConnectionStatus } from "#lib/types.js";
  import SettingRow from "./SettingRow.svelte";
  import SettingsGroup from "./SettingsGroup.svelte";
  import "./settings-controls.css";
  import { m } from "#lib/paraglide/messages.js";

  // Settings → Decision model → Advanced (#3071): model, API address and time budget. Each saves on
  // change and comes back from the server as the new status; a field the environment sets is
  // read-only with the variable named. Moving the address away from a stored key asks for the key
  // again up front — the server would refuse the move otherwise.
  let {
    status,
    query = "",
    count,
    expanded,
    ontoggle,
    onchange,
  }: {
    status: JudgeConnectionStatus | null;
    query?: string;
    count: number;
    expanded: boolean;
    ontoggle: () => void;
    onchange: (status: JudgeConnectionStatus) => void;
  } = $props();

  type Field = "model" | "baseUrl" | "timeoutMs";

  let modelDraft = $state("");
  let baseUrlDraft = $state("");
  let timeoutDraft = $state(8000);
  let baseUrlKey = $state("");
  let fieldBusy = $state(false);
  let fieldError = $state<{ field: Field; text: string } | null>(null);

  // Every new status — a load, a save here, a key saved above — resets the drafts to what is now
  // in force.
  $effect(() => {
    const s = status;
    if (!s) return;
    untrack(() => {
      modelDraft = s.model === s.defaults.model ? "" : s.model;
      baseUrlDraft = s.baseUrl === s.defaults.baseUrl ? "" : s.baseUrl;
      timeoutDraft = s.timeoutMs;
      baseUrlKey = "";
    });
  });

  const ENV_NAME: Record<Field, string> = {
    model: "SHEPHERD_JUDGE_MODEL",
    baseUrl: "SHEPHERD_JUDGE_BASE_URL",
    timeoutMs: "SHEPHERD_JUDGE_TIMEOUT_MS",
  };
  const envName = (field: Field) => ENV_NAME[field];

  function hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
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

  async function saveFields(field: Field, body: Parameters<typeof putJudgeConnection>[0]) {
    if (fieldBusy) return;
    fieldBusy = true;
    fieldError = null;
    try {
      const r = await putJudgeConnection(body);
      if ("error" in r) fieldError = { field, text: fieldErrorText(r) };
      else onchange(r);
    } catch {
      fieldError = { field, text: m.settings_dm_save_failed() };
    } finally {
      baseUrlKey = "";
      fieldBusy = false;
    }
  }

  function draftMatchesBaseUrl(): boolean {
    const s = status;
    if (!s) return true;
    const draft = baseUrlDraft.trim().replace(/\/+$/, "") || s.defaults.baseUrl;
    return draft === s.baseUrl;
  }
  const baseUrlNeedsKey = $derived(status?.keySource === "stored" && !draftMatchesBaseUrl());
  const baseUrlLocked = $derived(!!status && (status.env.baseUrl || status.env.key));

  function saveBaseUrl() {
    if (baseUrlNeedsKey || draftMatchesBaseUrl()) return;
    void saveFields("baseUrl", { baseUrl: baseUrlDraft });
  }

  function saveBaseUrlWithKey(e: SubmitEvent) {
    e.preventDefault();
    if (!baseUrlKey.trim()) return;
    void saveFields("baseUrl", { baseUrl: baseUrlDraft, key: baseUrlKey.trim() });
  }
</script>

<SettingsGroup label={m.settings_dm_group_advanced()} {count} {expanded} {ontoggle}>
  <SettingRow title={m.settings_dm_model_title()} description={m.settings_dm_model_hint()} {query}>
    {#snippet control()}
      <input
        class="set-txt"
        type="text"
        list="dm-models"
        spellcheck="false"
        autocomplete="off"
        placeholder={status?.defaults.model}
        aria-label={m.settings_dm_model_title()}
        disabled={!status || status.env.model || fieldBusy}
        bind:value={modelDraft}
        onchange={() => void saveFields("model", { model: modelDraft })}
      />
      <datalist id="dm-models">
        {#each status?.models ?? [] as name (name)}<option value={name}></option>{/each}
      </datalist>
    {/snippet}
    {#snippet below()}
      {#if status?.env.model}
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
        placeholder={status?.defaults.baseUrl}
        aria-label={m.settings_dm_base_url_title()}
        disabled={!status || baseUrlLocked || fieldBusy}
        bind:value={baseUrlDraft}
        onchange={saveBaseUrl}
      />
    {/snippet}
    {#snippet below()}
      {#if status?.env.key}
        <p class="dm-note">{m.settings_dm_base_url_env_key()}</p>
      {:else if status?.env.baseUrl}
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
          disabled={!status || status.env.timeoutMs || fieldBusy}
          bind:value={timeoutDraft}
          onchange={() => void saveFields("timeoutMs", { timeoutMs: Number(timeoutDraft) })}
        />
        <span class="dm-unit">{m.settings_dm_ms_unit()}</span>
      </span>
    {/snippet}
    {#snippet below()}
      {#if status?.env.timeoutMs}
        <p class="dm-note">{m.settings_dm_env_locked({ name: envName("timeoutMs") })}</p>
      {:else if fieldError?.field === "timeoutMs"}
        <p class="dm-note err" role="alert">{fieldError.text}</p>
      {/if}
    {/snippet}
  </SettingRow>
</SettingsGroup>

<style>
  .dm-note {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.5;
  }
  .dm-note.err {
    color: var(--color-red);
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

  @media (max-width: 768px) {
    .dm-note {
      font-size: var(--fs-base);
    }
  }
</style>
