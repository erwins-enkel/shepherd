<script lang="ts">
  import { onMount } from "svelte";
  import { listAccessTokens, createAccessToken, revokeAccessToken } from "$lib/api";
  import type { AccessToken, Settings } from "$lib/types";
  import HighlightText from "./HighlightText.svelte";
  import GlossaryText from "$lib/components/GlossaryText.svelte";
  import { REPO_URL } from "$lib/build-info";
  import "./settings-controls.css";
  import { m } from "$lib/paraglide/messages";

  // Access section (#2082): named machine bearer tokens, minted here and copied into whatever
  // client needs them (an Asyar/Raycast extension, the Capture extension, a cron job). The
  // plaintext lives in `revealed` — component state only, never re-fetchable — so a reload or a
  // section switch loses it, which is the point.
  let {
    payload,
    query = "",
  }: {
    payload: Settings | null;
    /** Active settings-search query — highlights this panel's indexed labels. */
    query?: string;
  } = $props();

  /** Mirrors ACCESS_TOKEN_EXPIRY_DAYS in src/access-tokens.ts; the server rejects anything else. */
  const EXPIRY_DAYS = [30, 90, 365];

  /** Mirrors ACCESS_TOKEN_PREFIX in src/access-tokens.ts — a protocol constant, not UI copy. */
  const TOKEN_PREFIX = "shp_";

  /** v1 tokens have the operator's full reach; the scope model is tracked here. */
  const SCOPES_ISSUE_URL = `${REPO_URL}/issues/2083`;

  let tokens = $state<AccessToken[]>([]);
  let loading = $state(true);
  let loadFailed = $state(false);

  let name = $state("");
  /** The <select> value: "never" or a preset day count as a string. */
  let expiry = $state("never");
  let creating = $state(false);
  let createError = $state("");

  /** The one-time plaintext. Cleared by the dismiss button — and by any reload. */
  let revealed = $state<string | null>(null);
  let copied = $state(false);

  let confirmingId = $state<string | null>(null);
  let revokingId = $state<string | null>(null);
  let revokeError = $state("");

  // Re-stamped on every (re)load rather than captured once at mount: the Settings dialog can sit
  // open for a long time, and a token that expires meanwhile must not keep reading as live.
  let now = $state(Date.now());
  const isExpired = (t: AccessToken) => t.expiresAt !== null && t.expiresAt <= now;

  function formatDate(ms: number): string {
    return new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" });
  }

  async function load() {
    loading = true;
    loadFailed = false;
    now = Date.now();
    try {
      tokens = (await listAccessTokens()).tokens;
    } catch {
      loadFailed = true;
    } finally {
      loading = false;
    }
  }

  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (creating || name.trim() === "") return;
    creating = true;
    createError = "";
    try {
      const minted = await createAccessToken(
        name.trim(),
        expiry === "never" ? null : Number(expiry),
      );
      revealed = minted.token;
      copied = false;
      tokens = [minted.entry, ...tokens];
      name = "";
      expiry = "never";
    } catch {
      createError = m.settings_access_create_failed();
    } finally {
      creating = false;
    }
  }

  async function copy() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed);
      copied = true;
    } catch {
      // clipboard blocked (insecure context / denied) — the value stays selectable on screen.
    }
  }

  async function revoke(id: string) {
    if (revokingId) return;
    revokingId = id;
    revokeError = "";
    try {
      await revokeAccessToken(id);
      tokens = tokens.filter((t) => t.id !== id);
      confirmingId = null;
    } catch {
      revokeError = m.settings_access_revoke_failed();
    } finally {
      revokingId = null;
    }
  }

  onMount(load);
</script>

<div class="block">
  <span class="micro"><HighlightText text={m.settings_access_env_title()} {query} /></span>
  {#if payload}
    <p class="hint">
      {payload.envTokenActive ? m.settings_access_env_active() : m.settings_access_env_inactive()}
    </p>
  {:else}
    <!-- Say nothing until the payload lands: "SHEPHERD_TOKEN is empty" is a claim, not a default. -->
    <p class="hint">{m.common_loading()}</p>
  {/if}
</div>

<div class="block">
  <span class="micro"><HighlightText text={m.settings_access_create_title()} {query} /></span>
  <p class="hint">
    <GlossaryText text={m.settings_access_create_hint()} />
  </p>
  <form class="mint" onsubmit={create}>
    <label class="fld">
      <span class="lbl">{m.settings_access_name_label()}</span>
      <input
        class="txt"
        type="text"
        bind:value={name}
        maxlength="64"
        required
        disabled={creating}
        placeholder={m.settings_access_name_placeholder()}
      />
    </label>
    <label class="fld expiry">
      <span class="lbl">{m.settings_access_expiry_label()}</span>
      <span class="set-select">
        <select bind:value={expiry} disabled={creating}>
          <option value="never">{m.settings_access_expiry_never()}</option>
          {#each EXPIRY_DAYS as days (days)}
            <option value={String(days)}>{m.settings_access_expiry_days({ days })}</option>
          {/each}
        </select>
        <span class="set-chev" aria-hidden="true">▾</span>
      </span>
    </label>
    <button type="submit" class="run" disabled={creating || name.trim() === ""}>
      {creating ? m.settings_access_creating() : m.settings_access_create_button()}
    </button>
  </form>
  <p class="hint warn-note">
    {m.settings_access_reach_note()}
    <a
      class="scopes-link"
      href={SCOPES_ISSUE_URL}
      target="_blank"
      rel="external noreferrer noopener"
      >{m.settings_access_scopes_link()} <span aria-hidden="true">↗</span></a
    >
  </p>
  {#if createError}<p class="hint err" role="alert">{createError}</p>{/if}
</div>

{#if revealed}
  <div class="reveal" role="status">
    <span class="micro reveal-title"
      ><span aria-hidden="true">⚠</span> {m.settings_access_reveal_title()}</span
    >
    <code class="value">{revealed}</code>
    <p class="hint">{m.settings_access_reveal_hint()}</p>
    <div class="reveal-btns">
      <button type="button" class="run" onclick={copy}>
        {copied ? m.settings_access_copied() : m.settings_access_copy()}
      </button>
      <button type="button" class="set-gbtn" onclick={() => (revealed = null)}>
        {m.settings_access_dismiss()}
      </button>
    </div>
  </div>
{/if}

<div class="block">
  <span class="micro"><HighlightText text={m.settings_access_list_title()} {query} /></span>
  {#if loading}
    <p class="hint">{m.common_loading()}</p>
  {:else if loadFailed}
    <p class="hint err" role="alert">{m.settings_access_load_failed()}</p>
    <button type="button" class="set-gbtn retry" onclick={load}>{m.common_retry()}</button>
  {:else if tokens.length === 0}
    <p class="hint">{m.settings_access_empty()}</p>
  {:else}
    <ul class="tokens">
      {#each tokens as t (t.id)}
        <li class="tok" class:expired={isExpired(t)}>
          <div class="tok-main">
            <span class="tok-name">{t.name}</span>
            <code class="tok-hint">{TOKEN_PREFIX}…{t.hint}</code>
            <span class="tok-meta">
              {m.settings_access_created({ date: formatDate(t.createdAt) })} ·
              {t.lastUsedAt === null
                ? m.settings_access_never_used()
                : m.settings_access_last_used({ date: formatDate(t.lastUsedAt) })} ·
              {#if t.expiresAt === null}
                {m.settings_access_expires_never()}
              {:else if isExpired(t)}
                <span class="badge">{m.settings_access_expired()}</span>
              {:else}
                {m.settings_access_expires({ date: formatDate(t.expiresAt) })}
              {/if}
            </span>
          </div>
          {#if confirmingId === t.id}
            <div class="confirm">
              <button
                type="button"
                class="set-gbtn danger"
                disabled={revokingId === t.id}
                onclick={() => revoke(t.id)}>{m.settings_access_revoke_yes()}</button
              >
              <button type="button" class="set-gbtn" onclick={() => (confirmingId = null)}
                >{m.common_cancel()}</button
              >
            </div>
          {:else}
            <button
              type="button"
              class="set-gbtn"
              onclick={() => (confirmingId = t.id)}
              aria-label={m.settings_access_revoke_aria({ name: t.name })}
              >{m.settings_access_revoke()}</button
            >
          {/if}
        </li>
      {/each}
    </ul>
    {#if revokeError}<p class="hint err" role="alert">{revokeError}</p>{/if}
  {/if}
</div>

<style>
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .block {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0;
  }
  .hint.err {
    color: var(--color-red);
  }
  .warn-note {
    color: var(--color-warn);
  }
  .scopes-link {
    color: var(--color-warn);
    white-space: nowrap;
  }
  .mint {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 10px;
    margin-top: 4px;
  }
  .fld {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1 1 220px;
    min-width: 0;
  }
  .fld.expiry {
    flex: 0 1 140px;
  }
  .lbl {
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .txt {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--color-line-bright);
    background: var(--color-inset);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    padding: 6px 10px;
    border-radius: 2px;
    min-height: 36px;
  }
  .txt:focus {
    outline: none;
    border-color: var(--color-amber);
  }
  .txt:disabled {
    opacity: 0.5;
  }
  .run {
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    background: transparent;
    padding: 9px 14px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  .run:disabled {
    opacity: 0.5;
    cursor: default;
    box-shadow: none;
  }
  /* The one-time reveal. Amber-edged so it reads as the thing to act on before it is gone. */
  .reveal {
    display: flex;
    flex-direction: column;
    gap: 8px;
    border: 1px solid var(--color-amber);
    background: var(--color-inset);
    padding: 12px;
    border-radius: 2px;
  }
  .reveal-title {
    color: var(--color-amber);
  }
  .value {
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    background: var(--color-head);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 8px 10px;
    overflow-wrap: anywhere;
    user-select: all;
  }
  .reveal-btns {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .retry {
    align-self: flex-start;
  }
  .tokens {
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .tok {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px 16px;
    padding: 12px 0;
    border-top: 1px solid var(--color-line);
  }
  .tok.expired .tok-main {
    opacity: 0.6;
  }
  .tok-main {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .tok-name {
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    overflow-wrap: anywhere;
  }
  .tok-hint {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .tok-meta {
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
  .badge {
    display: inline-block;
    border: 1px solid var(--status-warn);
    color: var(--status-warn);
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 0 5px;
    border-radius: 2px;
  }
  .confirm {
    display: flex;
    gap: 8px;
  }
  .set-gbtn.danger:hover:not(:disabled) {
    border-color: var(--color-red);
    color: var(--color-red);
  }

  @media (max-width: 768px) {
    .txt {
      min-height: 44px;
      font-size: var(--fs-lg);
    }
    .fld.expiry {
      flex: 1 1 100%;
    }
    .tok {
      align-items: flex-start;
    }
  }
</style>
