<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { getLocale } from "#lib/i18n.js";
  import { ApiError, deleteRepoSecret, listRepoSecrets, putRepoSecret } from "#lib/api.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { clock } from "#lib/now.svelte.js";
  import { relativeTimeAgo } from "#lib/format.js";
  import { agentSecretsExplanation } from "#lib/tooltips/explanations.js";
  import type { RepoSecret } from "#lib/types.js";
  import RepoSettingRow from "./RepoSettingRow.svelte";
  import "../automation-settings/automation-fields.css";

  // Per-repo agent secrets (#4122): machine-local, so the section renders it on the machine layer
  // only. The server never returns a value; a typed value lives in an input only until its save
  // succeeds, then both the input and its state are cleared.
  let {
    repoPath,
    autonomous = false,
    coach = "",
  }: {
    repoPath: string;
    /** The repo's effective profile is Autonomous: a secret still needs its host allowed. */
    autonomous?: boolean;
    coach?: string;
  } = $props();

  /** The server's name rule; reserved names stay the server's call. */
  const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

  const uid = $props.id();
  const errorId = `${uid}-error`;

  let secrets = $state<RepoSecret[]>([]);
  let failed = $state(false);
  let busy = $state(false);
  let seq = 0;

  let name = $state("");
  let value = $state("");
  let error = $state<string | null>(null);

  /** The secret whose inline Replace / Delete confirm is open; one at a time. */
  let replacing = $state<string | null>(null);
  let replaceValue = $state("");
  let deleting = $state<string | null>(null);

  $effect(() => void load(repoPath));

  async function load(repo: string) {
    const mine = ++seq;
    try {
      const list = await listRepoSecrets(repo);
      if (mine !== seq) return;
      secrets = list;
      failed = false;
    } catch {
      if (mine === seq) failed = true;
    }
  }

  /** The server's value rule, minus the limits only it enforces: one trailing newline is dropped. */
  const emptyValue = (v: string) => v.replace(/\r?\n$/, "") === "";

  /** Toast copy for a refused write, keyed by the server's reason. */
  function writeError(e: unknown, secret: string, fallback: () => string): string {
    const code = e instanceof ApiError ? e.code : undefined;
    if (code === "invalid-name") return m.automation_secrets_err_name();
    if (code === "reserved-name") return m.automation_secrets_err_reserved({ name: secret });
    if (code === "invalid-value") return m.automation_secrets_err_invalid_value({ name: secret });
    if (code === "too-many") return m.automation_secrets_err_too_many();
    if (code === "insufficient_scope") return m.automation_secrets_err_scope();
    if (e instanceof ApiError && e.status === 503) return m.automation_secrets_err_unavailable();
    return fallback();
  }

  async function save(secret: string, raw: string): Promise<boolean> {
    busy = true;
    try {
      await putRepoSecret(repoPath, secret, raw);
      toasts.info(m.automation_secrets_saved({ name: secret }));
      void load(repoPath);
      return true;
    } catch (e) {
      const msg = writeError(e, secret, () => m.automation_secrets_save_failed({ name: secret }));
      toasts.info(msg, { alert: true });
      return false;
    } finally {
      busy = false;
    }
  }

  async function add() {
    const n = name.trim();
    if (!NAME_RE.test(n)) {
      error = m.automation_secrets_err_name();
      return;
    }
    if (secrets.some((s) => s.name === n)) {
      error = m.automation_secrets_err_exists();
      return;
    }
    if (emptyValue(value)) {
      error = m.automation_secrets_err_value();
      return;
    }
    error = null;
    if (await save(n, value)) {
      name = "";
      value = "";
    }
  }

  function openReplace(secret: string) {
    deleting = null;
    replaceValue = "";
    replacing = secret;
  }

  function closeReplace() {
    replaceValue = "";
    replacing = null;
  }

  async function replace(secret: string) {
    if (emptyValue(replaceValue)) {
      toasts.info(m.automation_secrets_err_value(), { alert: true });
      return;
    }
    if (await save(secret, replaceValue)) closeReplace();
  }

  function openDelete(secret: string) {
    closeReplace();
    deleting = secret;
  }

  async function remove(secret: string) {
    busy = true;
    try {
      await deleteRepoSecret(repoPath, secret);
      secrets = secrets.filter((s) => s.name !== secret);
      deleting = null;
      toasts.info(m.automation_secrets_deleted({ name: secret }));
      void load(repoPath);
    } catch (e) {
      const msg = writeError(e, secret, () => m.automation_secrets_delete_failed({ name: secret }));
      toasts.info(msg, { alert: true });
    } finally {
      busy = false;
    }
  }

  const ago = (ms: number) => relativeTimeAgo(ms, clock.current, getLocale());
</script>

<RepoSettingRow
  field="agentSecrets"
  glyph="⚿"
  name={m.automation_secrets_name()}
  explanation={agentSecretsExplanation()}
  desc={m.automation_secrets_desc()}
  {coach}
>
  {#snippet below()}
    <div class="sec">
      {#if failed}
        <div class="sec-note">{m.automation_secrets_load_failed()}</div>
      {/if}
      {#if secrets.length}
        <ul class="sec-list">
          {#each secrets as s (s.name)}
            <li class="sec-item">
              <div class="sec-head">
                <span class="sec-name">{s.name}</span>
                <span class="sec-meta">
                  {m.automation_secrets_updated({ ago: ago(s.updatedAt) })} · {s.lastInjectedAt ==
                  null
                    ? m.automation_secrets_never_injected()
                    : m.automation_secrets_injected({ ago: ago(s.lastInjectedAt) })}
                </span>
              </div>
              {#if replacing === s.name}
                <form
                  class="drain-field"
                  aria-label={m.automation_secrets_replace_name({ name: s.name })}
                  onsubmit={(e) => {
                    e.preventDefault();
                    void replace(s.name);
                  }}
                >
                  <input
                    class="afield-num txt"
                    type="password"
                    autocomplete="off"
                    spellcheck="false"
                    aria-label={m.automation_secrets_replace_value({ name: s.name })}
                    placeholder={m.automation_secrets_value_placeholder()}
                    bind:value={replaceValue}
                  />
                  <button class="bs-btn primary" type="submit" disabled={busy}>
                    {m.automation_secrets_save()}
                  </button>
                  <button class="bs-btn" type="button" disabled={busy} onclick={closeReplace}>
                    {m.common_cancel()}
                  </button>
                </form>
              {:else if deleting === s.name}
                <div class="sec-confirm" role="group">
                  <span class="sec-confirm-text">
                    {m.automation_secrets_delete_confirm({ name: s.name })}
                  </span>
                  <div class="sec-actions">
                    <button
                      class="bs-btn danger"
                      type="button"
                      disabled={busy}
                      onclick={() => remove(s.name)}
                    >
                      {m.automation_secrets_delete_yes()}
                    </button>
                    <button
                      class="bs-btn"
                      type="button"
                      disabled={busy}
                      onclick={() => (deleting = null)}
                    >
                      {m.common_cancel()}
                    </button>
                  </div>
                </div>
              {:else}
                <div class="sec-actions">
                  <button
                    class="bs-btn"
                    type="button"
                    aria-label={m.automation_secrets_replace_name({ name: s.name })}
                    disabled={busy}
                    onclick={() => openReplace(s.name)}
                  >
                    {m.automation_secrets_replace()}
                  </button>
                  <button
                    class="bs-btn"
                    type="button"
                    aria-label={m.automation_secrets_delete_name({ name: s.name })}
                    disabled={busy}
                    onclick={() => openDelete(s.name)}
                  >
                    {m.automation_secrets_delete()}
                  </button>
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {:else if !failed}
        <div class="sec-note">{m.automation_secrets_empty()}</div>
      {/if}
      <form
        class="sec-add"
        aria-label={m.automation_secrets_add_label()}
        onsubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          class="afield-num txt"
          type="text"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          aria-label={m.automation_secrets_name_label()}
          placeholder={m.automation_secrets_name_placeholder()}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          bind:value={name}
          oninput={() => (error = null)}
        />
        <input
          class="afield-num txt"
          type="password"
          autocomplete="off"
          spellcheck="false"
          aria-label={m.automation_secrets_value_label()}
          placeholder={m.automation_secrets_value_placeholder()}
          bind:value
          oninput={() => (error = null)}
        />
        <button class="bs-btn" type="submit" disabled={busy}>{m.automation_secrets_save()}</button>
      </form>
      {#if error}
        <div class="sec-error" id={errorId} role="alert">{error}</div>
      {/if}
      <div class="sec-note">{m.automation_secrets_note_apply()}</div>
      <div class="sec-note">{m.automation_secrets_note_scope()}</div>
      {#if autonomous}
        <div class="sec-warn" role="note">{m.automation_secrets_egress_hint()}</div>
      {/if}
    </div>
  {/snippet}
</RepoSettingRow>

<style>
  .sec {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 6px;
  }
  .sec-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .sec-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 8px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
  }
  .sec-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 8px;
    min-width: 0;
  }
  .sec-name {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-ink-bright);
    overflow-wrap: anywhere;
  }
  .sec-meta {
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
  .sec-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .sec-confirm {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px 8px;
    border-left: 2px solid var(--color-red);
    background: var(--color-panel-2);
  }
  .sec-confirm-text {
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  .sec-add {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .sec-add > .afield-num {
    flex: 1 1 140px;
  }
  .afield-num[aria-invalid="true"] {
    border-color: var(--color-red);
  }
  .sec-error {
    font-size: var(--fs-meta);
    color: var(--color-red);
  }
  .sec-note {
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
  .sec-warn {
    font-size: var(--fs-meta);
    color: var(--status-warn);
  }
  .bs-btn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .bs-btn.danger {
    border-color: var(--color-red);
    color: var(--color-red);
  }
</style>
