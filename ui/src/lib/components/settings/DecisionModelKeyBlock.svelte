<script lang="ts">
  import { deleteJudgeConnection, putJudgeConnection, verifyJudgeConnection } from "#lib/api.js";
  import { formatAgo } from "#lib/format.js";
  import type { JudgeConnectionError, JudgeConnectionStatus } from "#lib/types.js";
  import "./settings-controls.css";
  import { m } from "#lib/paraglide/messages.js";

  // The JEV key of Settings → Decision model (#3071): paste + Save & verify, or what is on file —
  // never the key itself, only its last four characters — with Test / Replace / Remove. An
  // environment key is shown locked. The server checks the key before storing it and stores
  // nothing it did not accept; the pasted text lives only in this component and is cleared after
  // every attempt.
  let {
    status,
    onchange,
  }: {
    status: JudgeConnectionStatus;
    onchange: (status: JudgeConnectionStatus) => void;
  } = $props();

  let editing = $state(false);
  let keyText = $state("");
  let saving = $state(false);
  let testing = $state(false);
  let confirmRemove = $state(false);
  let removing = $state(false);
  let error = $state<string | null>(null);
  let keyInvalid = $state(false);

  const host = $derived(hostOf(status.baseUrl));
  const showForm = $derived(status.keySource === "none" || editing);

  function hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  function errorText(e: JudgeConnectionError): string {
    switch (e.error) {
      case "key_rejected":
        return m.settings_dm_key_rejected({ status: String(e.status ?? "—") });
      case "unreachable":
        return m.settings_dm_key_unreachable({ host });
      case "key_invalid":
        return m.settings_dm_key_invalid();
      case "env_locked":
        return m.settings_dm_key_env();
      default:
        return m.settings_dm_key_save_failed();
    }
  }

  function checkLine(s: JudgeConnectionStatus): string | null {
    const v = s.lastVerify;
    if (!v) return null;
    // Re-evaluated whenever `status` changes, which is when a check lands.
    if (v.result === "ok") return m.settings_dm_key_checked({ age: formatAgo(Date.now() - v.at) });
    if (v.result === "rejected") {
      return m.settings_dm_key_check_rejected({ status: String(v.status ?? "—") });
    }
    return m.settings_dm_key_check_unreachable({ host });
  }

  function savedLine(s: JudgeConnectionStatus): string | null {
    if (s.keySavedAt === null) return null;
    const date = new Date(s.keySavedAt).toLocaleDateString(undefined, { dateStyle: "medium" });
    return m.settings_dm_key_saved_on({ date });
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    const key = keyText.trim();
    if (saving || !key) return;
    saving = true;
    error = null;
    keyInvalid = false;
    try {
      const r = await putJudgeConnection({ key });
      if ("error" in r) {
        error = errorText(r);
        keyInvalid = r.field === "key";
      } else {
        editing = false;
        onchange(r);
      }
    } catch {
      error = m.settings_dm_key_save_failed();
    } finally {
      keyText = "";
      saving = false;
    }
  }

  async function test() {
    if (testing) return;
    testing = true;
    error = null;
    try {
      onchange(await verifyJudgeConnection());
    } catch {
      error = m.settings_dm_key_test_failed();
    } finally {
      testing = false;
    }
  }

  async function remove() {
    if (removing) return;
    removing = true;
    error = null;
    try {
      onchange(await deleteJudgeConnection());
      confirmRemove = false;
    } catch {
      error = m.settings_dm_key_remove_failed();
    } finally {
      removing = false;
    }
  }

  function cancel() {
    editing = false;
    keyText = "";
    error = null;
    keyInvalid = false;
  }
</script>

<div class="kblock">
  {#if status.keySource === "env"}
    <div class="onfile locked">
      <svg
        class="lock"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        ><rect x="4" y="11" width="16" height="10" rx="1"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"
        ></path></svg
      >
      <code class="mask">JEV_API_KEY</code>
      {#if status.keyLast4}<span class="mask"
          >{m.settings_dm_key_masked({
            last4: status.keyLast4,
          })}</span
        >{/if}
      {#if checkLine(status)}<span class="meta">{checkLine(status)}</span>{/if}
    </div>
    <p class="hint">{m.settings_dm_key_env()}</p>
    <div class="btns">
      <button type="button" class="set-gbtn" disabled={testing} onclick={test}
        >{testing ? m.settings_dm_key_verifying() : m.settings_dm_key_test()}</button
      >
    </div>
  {:else if showForm}
    {#if status.staleKeyHost}
      <p class="hint">
        {m.settings_dm_key_stale({ host: status.staleKeyHost, current: host })}
      </p>
    {/if}
    <form class="entry" onsubmit={save}>
      <input
        class="set-txt"
        type="password"
        autocomplete="off"
        spellcheck="false"
        placeholder={m.settings_dm_key_placeholder()}
        aria-label={m.settings_dm_key_title()}
        aria-invalid={keyInvalid}
        disabled={saving}
        bind:value={keyText}
        oninput={() => {
          error = null;
          keyInvalid = false;
        }}
      />
      <button type="submit" class="set-run" disabled={saving || keyText.trim() === ""}
        >{saving ? m.settings_dm_key_verifying() : m.settings_dm_key_save()}</button
      >
      {#if editing}
        <button type="button" class="set-gbtn" disabled={saving} onclick={cancel}
          >{m.common_cancel()}</button
        >
      {/if}
    </form>
    {#if saving}
      <p class="hint pending">{m.settings_dm_key_verify_note({ host })}</p>
    {/if}
  {:else}
    <div class="onfile">
      <span class="mask"
        >{status.keyLast4
          ? m.settings_dm_key_masked({ last4: status.keyLast4 })
          : m.settings_dm_key_masked_short()}</span
      >
      {#if savedLine(status)}<span class="meta">{savedLine(status)}</span>{/if}
      {#if checkLine(status)}<span class="meta">{checkLine(status)}</span>{/if}
    </div>
    <div class="btns">
      <button type="button" class="set-gbtn" disabled={testing} onclick={test}
        >{testing ? m.settings_dm_key_verifying() : m.settings_dm_key_test()}</button
      >
      <button type="button" class="set-gbtn" onclick={() => (editing = true)}
        >{m.settings_dm_key_replace()}</button
      >
      {#if confirmRemove}
        <button type="button" class="set-gbtn danger" disabled={removing} onclick={remove}
          >{m.settings_dm_key_remove_confirm()}</button
        >
        <button type="button" class="set-gbtn" onclick={() => (confirmRemove = false)}
          >{m.common_cancel()}</button
        >
      {:else}
        <button type="button" class="set-gbtn" onclick={() => (confirmRemove = true)}
          >{m.settings_dm_key_remove()}</button
        >
      {/if}
    </div>
  {/if}
  {#if error}<p class="hint err" role="alert">{error}</p>{/if}
</div>

<style>
  .kblock {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .entry {
    display: flex;
    gap: 8px;
    align-items: stretch;
    flex-wrap: wrap;
  }
  .entry .set-txt {
    flex: 1;
    min-width: 12em;
    width: auto;
  }
  .entry .set-txt[aria-invalid="true"] {
    border-color: var(--color-red);
  }
  .onfile {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    padding: 8px 10px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
  }
  .onfile.locked {
    border-style: dashed;
    border-color: var(--color-line-bright);
  }
  .lock {
    color: var(--color-faint);
    flex-shrink: 0;
  }
  .mask {
    color: var(--color-ink-bright);
    letter-spacing: 0.08em;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
  .meta {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .btns {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .hint {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.5;
  }
  .hint.pending {
    color: var(--color-amber);
  }
  .hint.err {
    color: var(--color-red);
  }

  @media (max-width: 768px) {
    .btns {
      justify-content: stretch;
    }
    .btns :global(.set-gbtn) {
      flex: 1;
    }
    .meta,
    .hint {
      font-size: var(--fs-base);
    }
  }
</style>
