<script lang="ts">
  import { onMount } from "svelte";
  import {
    listAccessTokens,
    createAccessToken,
    revokeAccessToken,
    listRepos,
    updateAccessTokenRepositories,
  } from "$lib/api";
  import type { AccessToken, Settings, TokenScope, RepoEntry } from "$lib/types";
  import TokenRepositoryPicker from "./TokenRepositoryPicker.svelte";
  import {
    buildAccessTokenInstructions,
    normalizeAgentServerUrl,
  } from "$lib/access-token-instructions";
  import HighlightText from "./HighlightText.svelte";
  import GlossaryText from "$lib/components/GlossaryText.svelte";
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

  /** Mirrors TOKEN_SCOPES in src/token-scopes.ts, widest last. The server owns the route policy
   *  and rejects anything else; this list only drives the picker's order. */
  const SCOPES: TokenScope[] = ["read", "submit", "full"];

  /** One line per level, describing what the token will and will not reach. Shown for the
   *  SELECTED scope so the operator reads the consequence before minting, not after. */
  const scopeLabel = (s: string) =>
    s === "read"
      ? m.settings_access_scope_read()
      : s === "submit"
        ? m.settings_access_scope_submit()
        : s === "full"
          ? m.settings_access_scope_full()
          : m.settings_access_scope_unknown();
  const scopeHint = (s: TokenScope) =>
    s === "read"
      ? m.settings_access_scope_read_hint()
      : s === "submit"
        ? m.settings_access_scope_submit_hint()
        : m.settings_access_scope_full_hint();

  let tokens = $state<AccessToken[]>([]);
  let loading = $state(true);
  let loadFailed = $state(false);

  let repos = $state<RepoEntry[]>([]);
  let reposLoading = $state(true);
  let reposFailed = $state(false);
  let allRepos = $state(false);
  let selectedRepos = $state<string[]>([]);
  let editingId = $state<string | null>(null);
  let editAll = $state(false);
  let editRepos = $state<string[]>([]);
  let savingRepos = $state(false);
  let repoError = $state("");
  let repoSaved = $state(false);
  const repoSummary = (t: AccessToken) =>
    t.repoPaths === null
      ? m.settings_access_repos_all()
      : t.repoPaths.length
        ? t.repoPaths.join(", ")
        : m.settings_access_repos_none();

  async function loadRepos() {
    reposLoading = true;
    reposFailed = false;
    try {
      repos = (await listRepos()).repos;
    } catch {
      reposFailed = true;
    } finally {
      reposLoading = false;
    }
  }

  function editRepositories(t: AccessToken) {
    editingId = t.id;
    editAll = t.repoPaths === null;
    editRepos = [...(t.repoPaths ?? [])];
    repoError = "";
    repoSaved = false;
  }

  async function saveRepositories(id: string) {
    if (savingRepos) return;
    savingRepos = true;
    repoError = "";
    try {
      const { entry } = await updateAccessTokenRepositories(id, editAll ? null : editRepos);
      tokens = tokens.map((t) => (t.id === id ? entry : t));
      if (revealedEntry?.id === id) {
        revealedEntry = entry;
        instructionsCopied = false;
      }
      editingId = null;
      repoSaved = true;
    } catch {
      repoError = m.settings_access_repos_save_failed();
    } finally {
      savingRepos = false;
    }
  }

  let name = $state("");
  /** The <select> value: "never" or a preset day count as a string. */
  let expiry = $state("never");
  /** Starts at the NARROWEST level: least privilege is what an operator gets by clicking through,
   *  and widening is the deliberate act. (The server defaults an absent scope to `full` instead,
   *  for #2082-era API callers — this form always sends one, so that default never applies here.) */
  let scope = $state<TokenScope>("read");
  let creating = $state(false);
  let createError = $state("");

  /** The one-time plaintext. Cleared by the dismiss button — and by any reload. */
  let revealed = $state<string | null>(null);
  let copied = $state(false);
  let revealedEntry = $state<AccessToken | null>(null);
  let serverUrl = $state("");
  let instructionsCopied = $state(false);
  let instructionsOpen = $state(false);
  let copyError = $state("");
  const normalizedUrl = $derived(normalizeAgentServerUrl(serverUrl));
  const instructions = $derived(
    revealed && revealedEntry && normalizedUrl
      ? buildAccessTokenInstructions(normalizedUrl, revealed, revealedEntry)
      : "",
  );

  function dismissRevealed() {
    revealed = null;
    revealedEntry = null;
    copied = false;
    instructionsCopied = false;
    copyError = "";
    instructionsOpen = false;
  }

  async function copyInstructions() {
    if (!instructions) return;
    copyError = "";
    try {
      await navigator.clipboard.writeText(instructions);
      instructionsCopied = true;
    } catch {
      instructionsCopied = false;
      copyError = m.settings_access_clipboard_failed();
      instructionsOpen = true;
    }
  }

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
    if (
      creating ||
      name.trim() === "" ||
      (!allRepos && (reposLoading || reposFailed || !selectedRepos.length))
    )
      return;
    creating = true;
    createError = "";
    try {
      const minted = await createAccessToken(
        name.trim(),
        expiry === "never" ? null : Number(expiry),
        scope,
        allRepos ? null : selectedRepos,
      );
      revealed = minted.token;
      revealedEntry = minted.entry;
      instructionsCopied = false;
      copyError = "";
      instructionsOpen = false;
      copied = false;
      tokens = [minted.entry, ...tokens];
      name = "";
      expiry = "never";
      scope = "read";
      allRepos = false;
      selectedRepos = [];
    } catch {
      createError = m.settings_access_create_failed();
    } finally {
      creating = false;
    }
  }

  async function copy() {
    if (!revealed) return;
    copyError = "";
    try {
      await navigator.clipboard.writeText(revealed);
      copied = true;
    } catch {
      copied = false;
      copyError = m.settings_access_clipboard_failed();
    }
  }

  async function revoke(id: string) {
    if (revokingId) return;
    revokingId = id;
    revokeError = "";
    try {
      await revokeAccessToken(id);
      tokens = tokens.filter((t) => t.id !== id);
      if (revealedEntry?.id === id) dismissRevealed();
      if (editingId === id) editingId = null;
      confirmingId = null;
    } catch {
      revokeError = m.settings_access_revoke_failed();
    } finally {
      revokingId = null;
    }
  }

  onMount(() => {
    serverUrl = window.location.origin;
    void load();
    void loadRepos();
  });
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
    <label class="fld scope">
      <span class="lbl">{m.settings_access_scope_label()}</span>
      <span class="set-select">
        <select bind:value={scope} disabled={creating}>
          {#each SCOPES as s (s)}
            <option value={s}>{scopeLabel(s)}</option>
          {/each}
        </select>
        <span class="set-chev" aria-hidden="true">▾</span>
      </span>
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
    <fieldset class="repo-field" disabled={creating}>
      <legend class="lbl">{m.settings_access_repos_label()}</legend>
      <TokenRepositoryPicker
        {repos}
        bind:all={allRepos}
        bind:selected={selectedRepos}
        disabled={creating || reposLoading || reposFailed}
      />
    </fieldset>
    {#if reposLoading}<p class="hint">{m.common_loading()}</p>{/if}
    {#if reposFailed}
      <p class="hint err" role="alert">{m.settings_access_repos_load_failed()}</p>
      <button type="button" class="set-gbtn" onclick={loadRepos}>{m.common_retry()}</button>
    {/if}
    <button
      type="submit"
      class="run"
      disabled={creating ||
        name.trim() === "" ||
        (!allRepos && (reposLoading || reposFailed || selectedRepos.length === 0))}
    >
      {creating ? m.settings_access_creating() : m.settings_access_create_button()}
    </button>
  </form>
  <!-- Describes the SELECTED scope. Amber only for `full`, which is the one level that warrants a
       warning; read/submit are a statement of limits, and colouring them as alarms would train the
       operator to ignore the colour. -->
  <p class="hint" class:warn-note={scope === "full"} aria-live="polite">
    {scopeHint(scope)}
    <GlossaryText text={m.settings_access_scope_fixed_note()} />
  </p>
  <p class="hint">{m.settings_access_repos_hint()}</p>
  {#if createError}<p class="hint err" role="alert">{createError}</p>{/if}
</div>

{#if revealed}
  <div class="reveal" role="status">
    <span class="micro reveal-title"
      ><span aria-hidden="true">⚠</span> {m.settings_access_reveal_title()}</span
    >
    <code class="value">{revealed}</code>
    <p class="hint">{m.settings_access_reveal_hint()}</p>
    <p class="hint">{m.settings_access_instructions_once()}</p>
    <label class="fld">
      <span class="lbl">{m.settings_access_server_label()}</span>
      <input
        class="txt"
        type="url"
        bind:value={serverUrl}
        oninput={() => (instructionsCopied = false)}
        aria-describedby="token-server-hint"
      />
    </label>
    <p class="hint" id="token-server-hint">{m.settings_access_server_hint()}</p>
    {#if !normalizedUrl}<p class="hint">{m.settings_access_server_invalid()}</p>{/if}
    <div class="reveal-btns">
      <button type="button" class="run" onclick={copy}>
        {copied ? m.settings_access_copied() : m.settings_access_copy()}
      </button>
      <button type="button" class="run" onclick={copyInstructions} disabled={!instructions}>
        {instructionsCopied
          ? m.settings_access_instructions_copied()
          : m.settings_access_instructions_copy()}
      </button>
      <button type="button" class="set-gbtn" onclick={dismissRevealed}>
        {m.settings_access_dismiss()}
      </button>
    </div>
    {#if copyError}<p class="hint err" role="alert">{copyError}</p>{/if}
    {#if instructions}
      <details bind:open={instructionsOpen}>
        <summary>{m.settings_access_instructions_preview()}</summary>
        <textarea
          class="txt instruction-text"
          readonly
          value={instructions}
          aria-label={m.settings_access_instructions_label()}></textarea>
      </details>
    {/if}
  </div>
{/if}

<div class="block">
  <span class="micro"><HighlightText text={m.settings_access_list_title()} {query} /></span>
  {#if repoSaved}<p class="hint" role="status">{m.settings_access_repos_saved()}</p>{/if}
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
            <span class="tok-id">
              <code class="tok-hint">{TOKEN_PREFIX}…{t.hint}</code>
              <!-- Read-only: a token's scope is fixed at mint, so there is nothing to click. -->
              <span class="badge scope-badge" class:full={t.scope === "full"}
                >{scopeLabel(t.scope)}</span
              >
            </span>
            <span class="tok-repos">{repoSummary(t)}</span>
            <button
              type="button"
              class="set-gbtn repo-edit"
              disabled={savingRepos}
              onclick={() => editRepositories(t)}>{m.settings_access_repos_edit()}</button
            >
            {#if editingId === t.id}
              <fieldset class="repo-field" disabled={savingRepos}>
                <legend class="lbl">{m.settings_access_repos_edit_label({ name: t.name })}</legend>
                <TokenRepositoryPicker
                  {repos}
                  bind:all={editAll}
                  bind:selected={editRepos}
                  disabled={savingRepos || reposLoading || reposFailed}
                />
                {#if repoError}<p class="hint err" role="alert">{repoError}</p>{/if}
                <div class="reveal-btns">
                  <button
                    type="button"
                    class="run"
                    disabled={savingRepos || reposLoading || reposFailed}
                    onclick={() => saveRepositories(t.id)}>{m.common_save()}</button
                  >
                  <button
                    type="button"
                    class="set-gbtn"
                    disabled={savingRepos}
                    onclick={() => (editingId = null)}>{m.common_cancel()}</button
                  >
                </div>
              </fieldset>
            {/if}
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
  .repo-field {
    border: 0;
    padding: 0;
    margin: 4px 0;
    min-width: 0;
    flex-basis: 100%;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .repo-field legend {
    padding: 0;
    margin-bottom: 8px;
  }
  .tok-repos {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    overflow-wrap: anywhere;
  }
  .repo-edit {
    align-self: flex-start;
  }
  .instruction-text {
    margin-top: 8px;
    min-height: 240px;
    resize: vertical;
  }
  summary {
    cursor: pointer;
    color: var(--color-ink);
    font-size: var(--fs-meta);
  }

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
  .fld.scope {
    flex: 0 1 160px;
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
  .reveal .fld {
    flex: initial;
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
  .tok-id {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
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
  /* MUST stay after `.badge`: both are single-class selectors, so source order is what decides —
     placed above it, `.badge`'s amber would win and every scope would read as `full`.
     Neutral by default because `read` and `submit` are limits, not alarms; `full` is the one level
     worth an amber edge, being the reach the operator should notice while scanning the list. */
  .scope-badge {
    border-color: var(--color-line-bright);
    color: var(--color-muted);
  }
  .scope-badge.full {
    border-color: var(--color-warn);
    color: var(--color-warn);
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
    .fld.expiry,
    .fld.scope {
      flex: 1 1 100%;
    }
    .tok {
      align-items: flex-start;
    }
  }
</style>
