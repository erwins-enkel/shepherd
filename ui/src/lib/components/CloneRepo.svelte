<script lang="ts">
  import { onMount } from "svelte";
  import {
    CloneFailedError,
    cloneRepo,
    getGithubAccess,
    getGithubRepos,
    type GithubAccess,
    type GithubRepo,
    type GitHelperInfo,
  } from "$lib/api";
  import type { RepoEntry } from "$lib/types";
  import { dialog } from "$lib/a11yDialog";
  import { accessCase, looksLikeGithubUrl } from "$lib/clone-access";
  import { m } from "$lib/paraglide/messages";
  import CloneAccessPanel from "./CloneAccessPanel.svelte";
  import CloneGitNote from "./CloneGitNote.svelte";
  import "./clone-access.css";

  let {
    onclose,
    ondone,
    repoRootDisplay = "~/projects",
  }: {
    onclose?: () => void;
    ondone: (entry: RepoEntry) => void;
    repoRootDisplay?: string;
  } = $props();

  // ── URL fallback (the original clone-by-URL flow) ──
  let url = $state("");
  let submitting = $state(false);
  let error = $state<string | null>(null);
  let retry = $state<(() => void) | null>(null);

  // ── GitHub repo picker ──
  let repos = $state<GithubRepo[]>([]);
  let login = $state<string | null>(null);
  let available = $state(false);
  let loadingRepos = $state(true);
  let query = $state("");
  /** Clone URL of the list repo currently being cloned (drives its row spinner). */
  let cloningUrl = $state<string | null>(null);
  /** Whether the clone-by-URL fallback section is expanded. */
  let showUrl = $state(false);
  /** git's credential helper for github.com — the list above comes from gh, the clone doesn't. */
  let git = $state<GitHelperInfo | null>(null);

  // ── refused GitHub clone → CloneAccessPanel ──
  /** The refused clone the access panel explains; `seq` remounts the panel per failure, and
   *  `listRepo` (a list clone) collapses the list to that one repo. */
  type Failure = {
    url: string;
    repo: string;
    detail?: string;
    initial?: GithubAccess;
    listRepo: GithubRepo | null;
    seq: number;
  };
  let failure = $state<Failure | null>(null);
  let failSeq = 0;

  onMount(async () => {
    const res = await getGithubRepos();
    repos = res.repos;
    login = res.login;
    available = res.available;
    git = res.git ?? null;
    loadingRepos = false;
    // No listing available (gh missing/unauthed) → the URL field is the only path.
    if (!available) showUrl = true;
  });

  const targetName = $derived.by(() => {
    const segment = url.split("/").filter(Boolean).at(-1) ?? "";
    return segment.replace(/\.git$/i, "").trim();
  });

  // Not-yet-cloned repos that match the filter, grouped by owner with the user's own
  // account first, then the teams/orgs they belong to (alphabetical). Repos inside a
  // group are alphabetical too — the server returns them most-recently-pushed first,
  // which is unscannable in a long list.
  const groups = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const visible = repos.filter(
      (r) => !r.cloned && (q === "" || r.nameWithOwner.toLowerCase().includes(q)),
    );
    const byOwner: Record<string, GithubRepo[]> = {};
    const owners: string[] = [];
    for (const r of visible) {
      if (!byOwner[r.owner]) {
        byOwner[r.owner] = [];
        owners.push(r.owner);
      }
      byOwner[r.owner].push(r);
    }
    owners.sort((a, b) => {
      if (login) {
        if (a === login) return -1;
        if (b === login) return 1;
      }
      return a.localeCompare(b);
    });
    return owners.map((owner) => ({
      owner,
      isSelf: owner === login,
      repos: byOwner[owner].sort((a, b) => a.name.localeCompare(b.name)),
    }));
  });

  const hasVisible = $derived(groups.length > 0);
  const busy = $derived(submitting || cloningUrl !== null);

  function msg(code: string): string {
    switch (code) {
      case "auth":
        return m.clonerepo_failed_auth();
      case "exists":
        return m.clonerepo_failed_exists();
      case "url":
        return m.clonerepo_failed_url();
      case "outside":
        return m.clonerepo_failed_outside();
      case "timeout":
        return m.clonerepo_failed_timeout();
      default:
        return m.clonerepo_failed_generic();
    }
  }

  /** Map a failed clone to the error line, and — for a github.com URL — hand it to the
   *  access panel: a refusal (`auth`) always, a "not found" (`url`) only when gh can see the
   *  repo, since a git token for another account reads a private repo as missing. */
  function cloneFailed(
    err: unknown,
    cloneUrl: string,
    repoLabel: string,
    listRepo: GithubRepo | null,
    again: () => void,
  ) {
    const code = err instanceof Error ? err.message.replace(/^clonerepo_failed_/, "") : "";
    const detail = err instanceof CloneFailedError ? err.detail : undefined;
    error = msg(code);
    retry = again;
    failure = null;
    if (!looksLikeGithubUrl(cloneUrl)) return;
    const seq = ++failSeq;
    // The panel replaces the error line; `retry` stays for the panel's "try again".
    if (code === "auth") {
      failure = { url: cloneUrl, repo: repoLabel, detail, listRepo, seq };
      error = null;
    } else if (code === "url") {
      getGithubAccess(cloneUrl)
        .then((a) => {
          if (seq === failSeq && accessCase(a) === "mismatch") {
            failure = { url: cloneUrl, repo: repoLabel, detail, initial: a, listRepo, seq };
            error = null;
          }
        })
        .catch(() => {
          /* the URL message stands */
        });
    }
  }

  async function cloneFromList(repo: GithubRepo) {
    if (busy) return;
    cloningUrl = repo.url;
    error = null;
    retry = null;
    try {
      const entry = await cloneRepo(repo.url);
      ondone(entry);
    } catch (err) {
      cloneFailed(err, repo.url, repo.nameWithOwner, repo, () => cloneFromList(repo));
    } finally {
      cloningUrl = null;
    }
  }

  async function cloneByUrl(target: string) {
    if (busy) return;
    submitting = true;
    error = null;
    retry = null;
    try {
      const entry = await cloneRepo(target);
      ondone(entry);
    } catch (err) {
      const label = target.replace(/^.*github\.com[:/]/i, "").replace(/\.git$/i, "");
      cloneFailed(err, target, label, null, () => cloneByUrl(target));
    } finally {
      submitting = false;
    }
  }

  function submit(e: Event) {
    e.preventDefault();
    if (!url.trim() || busy) return;
    void cloneByUrl(url.trim());
  }

  /** Leave the focused refused-repo view for the full list. */
  function back() {
    failure = null;
    error = null;
    retry = null;
  }
</script>

{#snippet accessPanel()}
  {#if failure}
    {#key failure.seq}
      <CloneAccessPanel
        url={failure.url}
        repo={failure.repo}
        detail={failure.detail}
        initial={failure.initial}
        cloning={busy}
        onretry={() => retry?.()}
      />
    {/key}
  {/if}
{/snippet}

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose?.();
  }}
>
  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
  <form
    class="card bracket"
    role="dialog"
    aria-modal="true"
    aria-label={m.clonerepo_title()}
    use:dialog={{ onclose: () => onclose?.() }}
    onsubmit={submit}
  >
    <div class="chead">
      <span class="micro">{m.clonerepo_title()}</span>
      <button type="button" class="x" onclick={() => onclose?.()} aria-label={m.common_close()}
        >✕</button
      >
    </div>

    {#if loadingRepos}
      <p class="status">{m.clonerepo_loading_repos()}</p>
    {:else if available && failure?.listRepo}
      {@const fr = failure.listRepo}
      <button type="button" class="ca-link" onclick={back}>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"><path d="M19 12H5" /><path d="M11 6l-6 6 6 6" /></svg
        >
        {m.cloneaccess_back()}
      </button>
      <div class="failedrow">
        <span class="rname">{fr.nameWithOwner}</span>
        {#if fr.isPrivate}<span class="tag" title={m.clonerepo_private()}>🔒</span>{/if}
        {#if cloningUrl === fr.url}
          <span class="rstatus">{m.clonerepo_cloning()}</span>
        {:else}
          <span class="ca-badge bad">{m.cloneaccess_badge_no_git()}</span>
        {/if}
      </div>
      {@render accessPanel()}
    {:else if available}
      {#if git}<CloneGitNote {git} {login} />{/if}
      <label class="micro" for="cr-search">{m.clonerepo_pick_label()}</label>
      <input
        id="cr-search"
        class="search"
        type="text"
        bind:value={query}
        placeholder={m.clonerepo_search_placeholder()}
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck={false}
      />
      {#if hasVisible}
        <div class="repolist">
          {#each groups as g (g.owner)}
            <p class="owner-head">
              {g.owner}{#if g.isSelf}<span class="you"> · {m.clonerepo_owner_you()}</span>{/if}
            </p>
            {#each g.repos as r (r.nameWithOwner)}
              <button
                type="button"
                class="repo"
                onclick={() => cloneFromList(r)}
                disabled={busy}
                title={r.nameWithOwner}
              >
                <span class="rname">{r.name}</span>
                {#if r.isPrivate}<span class="tag" title={m.clonerepo_private()}>🔒</span>{/if}
                {#if r.isArchived}<span class="tag">{m.clonerepo_archived()}</span>{/if}
                {#if cloningUrl === r.url}
                  <span class="rstatus">{m.clonerepo_cloning()}</span>
                {/if}
              </button>
            {/each}
          {/each}
        </div>
      {:else}
        <p class="status">{query.trim() ? m.clonerepo_no_match() : m.clonerepo_no_repos()}</p>
      {/if}
    {:else}
      <p class="status">{m.clonerepo_repos_unavailable()}</p>
    {/if}

    <button
      type="button"
      class="disclosure"
      onclick={() => (showUrl = !showUrl)}
      aria-expanded={showUrl}
    >
      {m.clonerepo_url_toggle()}
    </button>

    {#if showUrl}
      <label class="micro" for="cr-url">{m.clonerepo_url_label()}</label>
      <input
        id="cr-url"
        type="url"
        bind:value={url}
        placeholder={m.clonerepo_url_placeholder()}
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck={false}
      />

      {#if targetName}
        <p class="preview">
          {m.clonerepo_target_preview({ root: repoRootDisplay, name: targetName })}
        </p>
      {/if}

      <button class="run" type="submit" disabled={busy}>
        {submitting ? m.clonerepo_cloning() : m.clonerepo_submit()}
      </button>
    {/if}

    {#if failure && !failure.listRepo}
      {@render accessPanel()}
    {/if}

    {#if error}
      <div class="err" role="alert">
        <span>{error}</span>
        {#if retry}
          <button type="button" class="retry" onclick={() => retry?.()}>{m.common_retry()}</button>
        {/if}
      </div>
    {/if}
  </form>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--color-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    /* 30 (not the usual 20) so this modal sits ABOVE the Backlog overlay (z-index:20)
       when launched from its "+ Add repo" menu — the overlay stays mounted underneath,
       preserving the user's place. Matches the higher-modal tier (UpdateModal etc.). */
    z-index: 30;
  }
  .card {
    position: relative;
    width: min(520px, 92vw);
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .bracket::before,
  .bracket::after {
    content: "";
    position: absolute;
    width: 10px;
    height: 10px;
    border: 1px solid var(--color-line-bright);
  }
  .bracket::before {
    top: -1px;
    left: -1px;
    border-right: 0;
    border-bottom: 0;
  }
  .bracket::after {
    bottom: -1px;
    right: -1px;
    border-left: 0;
    border-top: 0;
  }
  .chead {
    display: flex;
    align-items: center;
    margin-bottom: 8px;
  }
  .x {
    margin-left: auto;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
    margin-top: 6px;
  }
  input {
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    padding: 8px 10px;
    border-radius: 2px;
    width: 100%;
    box-sizing: border-box;
  }
  input:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }
  .preview {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 0;
    padding: 2px 0;
  }
  .status {
    font-size: var(--fs-base);
    color: var(--color-muted);
    margin: 8px 0;
    padding: 2px 0;
  }
  .repolist {
    display: flex;
    flex-direction: column;
    gap: 1px;
    max-height: 42vh;
    overflow-y: auto;
    margin-top: 4px;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
  }
  .owner-head {
    position: sticky;
    top: 0;
    margin: 0;
    padding: 6px 10px 4px;
    font-size: var(--fs-meta);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-muted);
    background: var(--color-inset);
    border-bottom: 1px solid var(--color-line);
  }
  .owner-head .you {
    color: var(--color-amber);
    text-transform: none;
    letter-spacing: 0;
  }
  .repo {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    padding: 8px 10px;
    cursor: pointer;
  }
  .repo:hover:not(:disabled) {
    background: var(--color-panel);
  }
  .repo:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .failedrow {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 10px;
    border: 1px solid var(--color-line-bright);
    background: var(--color-inset);
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
  }
  .rname {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tag {
    flex-shrink: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .rstatus {
    flex-shrink: 0;
    font-size: var(--fs-meta);
    color: var(--color-amber);
  }
  .disclosure {
    align-self: flex-start;
    margin-top: 10px;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    cursor: pointer;
    padding: 4px 0;
  }
  .disclosure:hover {
    color: var(--color-ink-bright);
  }
  .err {
    color: var(--color-red);
    font-size: var(--fs-meta);
    margin-top: 6px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .retry {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-amber);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    padding: 3px 8px;
    cursor: pointer;
  }
  .retry:hover {
    border-color: var(--color-amber);
  }
  .run {
    margin-top: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
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
  }

  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
    }
    .card {
      width: 100%;
      max-width: none;
      height: 100dvh;
      border: 0;
      overflow-y: auto;
      animation: sheet-up 0.18s ease-out;
    }
    input {
      /* 16px no-zoom font-size comes from the global iOS guard in app.css */
      min-height: 44px;
    }
    .run {
      min-height: 44px;
    }
    .repo {
      min-height: 44px;
    }
    .repolist {
      max-height: none;
    }
    .chead {
      margin-bottom: 6px;
      min-height: 44px;
    }
    .chead .micro {
      display: none;
    }
    .x {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      margin-right: -10px;
      font-size: var(--fs-lg);
    }
  }

  @keyframes sheet-up {
    from {
      transform: translateY(12px);
      opacity: 0.6;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
</style>
