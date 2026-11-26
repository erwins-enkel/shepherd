<script lang="ts">
  // Settings → Resources → Postgres (#4232): the shared, on-demand Postgres server Shepherd runs
  // for repos that opt in, picked here (SettingsPostgresRepos) or under Repo settings → Agent.
  // Each field saves on change.
  import { onMount } from "svelte";
  import { getSettings, putPostgresSettings } from "#lib/api.js";
  import type { PostgresSettings } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import SettingRow from "./SettingRow.svelte";
  import SettingToggle from "./SettingToggle.svelte";
  import SettingsPostgresRepos from "./SettingsPostgresRepos.svelte";
  import "./settings-controls.css";

  let { query = "" }: { query?: string } = $props();
  let settings = $state<PostgresSettings | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state("");

  onMount(() => {
    let disposed = false;
    void getSettings()
      .then((s) => {
        if (!disposed) settings = s.postgres ?? null;
      })
      .catch(() => {})
      .finally(() => {
        if (!disposed) loading = false;
      });
    return () => {
      disposed = true;
    };
  });

  async function save(patch: Partial<PostgresSettings>) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      settings = (await putPostgresSettings(patch)).postgres;
    } catch {
      error = m.postgres_settings_save_failed();
    } finally {
      busy = false;
    }
  }

  async function numberChange(event: Event, key: "port" | "idleMinutes") {
    const input = event.currentTarget as HTMLInputElement;
    if (!settings || !input.reportValidity()) return;
    await save({ [key]: input.valueAsNumber });
    input.value = String(settings[key]);
  }

  async function imageChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    if (!settings) return;
    const value = input.value.trim();
    if (value && value !== settings.image) await save({ image: value });
    input.value = settings.image;
  }
</script>

<h3>{m.postgres_settings_heading()}</h3>
<p class="hint">{m.postgres_settings_scope()}</p>
{#if loading}
  <p>{m.common_loading()}</p>
{:else if !settings}
  <p role="alert">{m.postgres_settings_unavailable()}</p>
{:else}
  <SettingRow title={m.postgres_settings_enabled()} {query} inlineOnMobile>
    {#snippet control()}<SettingToggle
        label={m.postgres_settings_enabled()}
        checked={settings!.enabled}
        disabled={busy}
        onchange={() => save({ enabled: !settings!.enabled })}
      />{/snippet}
  </SettingRow>
  {#if error}<p role="alert">{error}</p>{/if}
  <fieldset disabled={busy || !settings.enabled}>
    <SettingRow
      title={m.postgres_settings_port()}
      description={m.postgres_settings_port_hint()}
      {query}
    >
      {#snippet control()}<input
          class="set-num"
          type="number"
          min="1024"
          max="65535"
          step="1"
          required
          aria-label={m.postgres_settings_port()}
          value={settings!.port}
          onchange={(e) => numberChange(e, "port")}
        />{/snippet}
    </SettingRow>
    <SettingRow
      title={m.postgres_settings_idle()}
      description={m.postgres_settings_idle_hint()}
      {query}
    >
      {#snippet control()}<input
          class="set-num"
          type="number"
          min="1"
          max="1440"
          step="1"
          required
          aria-label={m.postgres_settings_idle()}
          value={settings!.idleMinutes}
          onchange={(e) => numberChange(e, "idleMinutes")}
        />{/snippet}
    </SettingRow>
    <SettingRow
      title={m.postgres_settings_image()}
      description={m.postgres_settings_image_hint()}
      {query}
    >
      {#snippet control()}<input
          class="set-num image"
          type="text"
          spellcheck="false"
          autocomplete="off"
          aria-label={m.postgres_settings_image()}
          value={settings!.image}
          onchange={imageChange}
        />{/snippet}
    </SettingRow>
  </fieldset>
  <SettingsPostgresRepos globalEnabled={settings.enabled} {query} />
{/if}

<style>
  fieldset {
    border: 0;
    padding: 0;
    margin: 0;
    min-width: 0;
  }
  fieldset:disabled {
    opacity: 0.5;
  }
  h3 {
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    margin: 20px 0 8px;
  }
  .hint {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .image {
    width: 12em;
  }
</style>
