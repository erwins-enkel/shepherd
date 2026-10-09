<script lang="ts">
  import { untrack } from "svelte";
  import { putApnsConfig } from "#lib/api.js";
  import type { ApnsField, ApnsStatus } from "#lib/types.js";
  import "./settings-controls.css";
  import { m } from "#lib/paraglide/messages.js";

  // The APNs setup form of Settings → Notifications (#2696): the .p8 by file, drop or paste,
  // Key ID (prefilled from AuthKey_<ID>.p8), Team ID and, under Advanced, the topic. The server
  // validates; a refusal names the field and is explained here in plain words. Fields the
  // environment sets are read-only and never sent.
  let {
    apns,
    replacing = false,
    onsaved,
    oncancel,
  }: {
    apns: ApnsStatus;
    /** A key is already on file: an empty key keeps it, and the form can be cancelled. */
    replacing?: boolean;
    onsaved: (status: ApnsStatus) => void;
    oncancel?: () => void;
  } = $props();

  /** The server's default topic (DEFAULT_APNS_TOPIC in src/apns-settings.ts). */
  const DEFAULT_TOPIC = "run.shepherd.ios";
  /** Apple names the downloaded key `AuthKey_<KEY ID>.p8`. */
  const KEY_FILE_RE = /AuthKey_([A-Za-z0-9]{10})\.p8$/;
  const ENV_NAME: Record<ApnsField, string> = {
    key: "SHEPHERD_APNS_KEY",
    keyId: "SHEPHERD_APNS_KEY_ID",
    teamId: "SHEPHERD_APNS_TEAM_ID",
    topic: "SHEPHERD_APNS_TOPIC",
  };

  // Seeded once from the status the form opened with; the operator edits from there.
  let keyId = $state(untrack(() => apns.keyId ?? ""));
  let teamId = $state(untrack(() => apns.teamId ?? ""));
  let topic = $state(untrack(() => (apns.topic === DEFAULT_TOPIC ? "" : apns.topic)));
  let fileName = $state<string | null>(null);
  let fileKey = $state("");
  let pastedKey = $state("");
  let dragging = $state(false);
  let saving = $state(false);
  let saveError = $state<{ field: ApnsField | null; text: string } | null>(null);

  const keyText = $derived(fileKey || pastedKey.trim());

  /** Plain-language text for a refused save, by the server's error code. */
  function saveErrorText(code: string, field: ApnsField): string {
    switch (code) {
      case "env_locked":
        return m.settings_notify_env_locked({ name: ENV_NAME[field] });
      case "key_required":
        return m.settings_notify_err_key_required();
      case "invalid":
      case "unreadable":
        return m.settings_notify_key_error_invalid();
      case "not_p256":
        return m.settings_notify_key_error_not_p256();
      case "key_id_invalid":
        return m.settings_notify_err_key_id();
      case "team_id_invalid":
        return m.settings_notify_err_team_id();
      case "topic_invalid":
        return m.settings_notify_err_topic();
      default:
        return m.settings_notify_save_failed();
    }
  }

  async function readKeyFile(file: File) {
    saveError = null;
    fileName = file.name;
    fileKey = (await file.text()).trim();
    const fromName = KEY_FILE_RE.exec(file.name)?.[1];
    if (fromName && !apns.env.keyId) keyId = fromName.toUpperCase();
  }

  function onFileInput(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (file) void readKeyFile(file);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    const file = e.dataTransfer?.files?.[0];
    if (file) void readKeyFile(file);
  }

  /** Only what this form may change: env-locked fields would be refused, and an empty key on a
   *  replace means "keep the stored one". */
  function body(): Partial<Record<ApnsField, string>> {
    const b: Partial<Record<ApnsField, string>> = {};
    if (!apns.env.key && keyText) b.key = keyText;
    if (!apns.env.keyId) b.keyId = keyId;
    if (!apns.env.teamId) b.teamId = teamId;
    if (!apns.env.topic) b.topic = topic;
    return b;
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (saving) return;
    saving = true;
    saveError = null;
    try {
      const r = await putApnsConfig(body());
      if ("error" in r) saveError = { field: r.field, text: saveErrorText(r.error, r.field) };
      else onsaved(r);
    } catch {
      saveError = { field: null, text: m.settings_notify_save_failed() };
    } finally {
      saving = false;
    }
  }
</script>

<form class="setup" onsubmit={save}>
  <div class="fld">
    <span class="set-lbl">{m.settings_notify_key_label()}</span>
    {#if apns.env.key}
      <p class="hint locked">{m.settings_notify_env_locked({ name: ENV_NAME.key })}</p>
    {:else}
      <div
        class="drop"
        class:dragging
        class:invalid={saveError?.field === "key"}
        role="group"
        aria-label={m.settings_notify_key_label()}
        ondragover={(e) => {
          e.preventDefault();
          dragging = true;
        }}
        ondragleave={() => (dragging = false)}
        ondrop={onDrop}
      >
        {#if fileName}
          <span class="file">{m.settings_notify_file_loaded({ name: fileName })}</span>
        {:else}
          <span class="hint">{m.settings_notify_drop()}</span>
        {/if}
        <label class="set-gbtn pick">
          {m.settings_notify_choose_file()}
          <input type="file" accept=".p8,.pem,text/plain" onchange={onFileInput} />
        </label>
      </div>
      {#if !fileName}
        <textarea
          class="set-txt pem"
          rows="3"
          spellcheck="false"
          autocomplete="off"
          aria-label={m.settings_notify_paste_label()}
          placeholder={m.settings_notify_paste_placeholder()}
          bind:value={pastedKey}></textarea>
      {/if}
      {#if replacing}<p class="hint">{m.settings_notify_keep_key_hint()}</p>{/if}
    {/if}
  </div>
  <div class="ids">
    <label class="fld">
      <span class="set-lbl">{m.settings_notify_key_id_label()}</span>
      <input
        class="set-txt mono"
        class:invalid={saveError?.field === "keyId"}
        type="text"
        maxlength="10"
        autocomplete="off"
        spellcheck="false"
        disabled={apns.env.keyId}
        bind:value={keyId}
      />
    </label>
    <label class="fld">
      <span class="set-lbl">{m.settings_notify_team_id_label()}</span>
      <input
        class="set-txt mono"
        class:invalid={saveError?.field === "teamId"}
        type="text"
        maxlength="10"
        autocomplete="off"
        spellcheck="false"
        disabled={apns.env.teamId}
        bind:value={teamId}
      />
    </label>
  </div>
  {#if apns.env.keyId || apns.env.teamId}
    <p class="hint locked">{m.settings_notify_ids_env_hint()}</p>
  {/if}
  <details class="adv" open={saveError?.field === "topic" || apns.env.topic}>
    <summary class="set-lbl">{m.settings_notify_advanced()}</summary>
    <label class="fld">
      <span class="set-lbl">{m.settings_notify_topic_label()}</span>
      <input
        class="set-txt mono"
        class:invalid={saveError?.field === "topic"}
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder={DEFAULT_TOPIC}
        disabled={apns.env.topic}
        bind:value={topic}
      />
    </label>
    <p class="hint">
      {apns.env.topic
        ? m.settings_notify_env_locked({ name: ENV_NAME.topic })
        : m.settings_notify_topic_hint()}
    </p>
  </details>
  {#if saveError}<p class="hint err" role="alert">{saveError.text}</p>{/if}
  <div class="btns">
    <button type="submit" class="set-run" disabled={saving}>
      {saving ? m.settings_notify_saving() : m.settings_notify_save()}
    </button>
    {#if replacing}
      <button type="button" class="set-gbtn" onclick={() => oncancel?.()}
        >{m.common_cancel()}</button
      >
    {/if}
  </div>
</form>

<style>
  .setup {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 4px;
  }
  .hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0;
  }
  .hint.err {
    color: var(--color-red);
  }
  .hint.locked {
    color: var(--color-muted);
  }
  .fld {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .ids {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  .ids .fld {
    flex: 1 1 160px;
  }
  .mono,
  .pem {
    font-family: var(--font-mono);
  }
  .pem {
    font-size: var(--fs-meta);
    resize: vertical;
  }
  .invalid,
  .drop.invalid {
    border-color: var(--color-red);
  }
  .drop {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    border: 1px dashed var(--color-line-bright);
    background: var(--color-inset);
    border-radius: 2px;
    padding: 10px 12px;
  }
  .drop.dragging {
    border-color: var(--color-amber);
  }
  .file {
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    overflow-wrap: anywhere;
  }
  /* The native file input stays in the label (keyboard + screen readers reach it through the
     label's button look) but takes no space of its own. */
  .pick {
    position: relative;
    overflow: hidden;
  }
  .pick input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }
  .pick:focus-within {
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .adv summary {
    cursor: pointer;
    list-style-position: inside;
  }
  .adv[open] {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .btns {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
</style>
