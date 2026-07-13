<script lang="ts">
  import { createProject, getCommands, getGithubOwners } from "$lib/api";
  import type { RepoEntry } from "$lib/types";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";
  import { commandInsertable, commandProviders } from "$lib/slash";
  import { onMount } from "svelte";

  // Slug rule mirrors src/validate.ts PROJECT_SLUG_RE exactly.
  // Cross-reference: keep both patterns in sync when either changes.
  const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;

  // Curated allow-list of kickoff command bare names (strip plugin: prefix).
  const KICKOFF_COMMANDS = new Set([
    "gsd-new-project",
    "impeccable",
    "create_plan",
    "gsd-explore",
    "shaping",
  ]);

  export type KickoffChoice = { kind: "prd" } | { kind: "command"; name: string };

  let {
    onclose,
    ondone,
    repoRootDisplay = "~/projects",
  }: {
    onclose?: () => void;
    ondone: (entry: RepoEntry & { warning?: string }, kickoff: KickoffChoice, idea: string) => void;
    repoRootDisplay?: string;
  } = $props();

  let name = $state("");
  let idea = $state("");
  let createRemote = $state(false);
  let visibility = $state<"private" | "public">("private");
  // GitHub owner: "" → personal account, otherwise an org slug. Owners are fetched
  // lazily the first time the GitHub box is checked; the picker only renders when the
  // user belongs to at least one org (otherwise there's nothing to choose).
  let owner = $state("");
  let ownerLogin = $state<string | null>(null);
  let ownerOrgs = $state<string[]>([]);
  let ownersLoaded = $state(false);
  // String sentinel for the select bind — avoids Svelte 5 reference-equality bug with object values.
  // "__prd__" → { kind: "prd" }, any other value → { kind: "command", name: value }.
  let kickoffValue = $state<string>("__prd__");
  let kickoffCommands = $state<string[]>([]);
  let submitting = $state(false);
  let error = $state<string | null>(null);
  let retry = $state<(() => void) | null>(null);

  const nameInvalid = $derived.by(() => {
    if (!name) return false;
    const n = name.trim();
    if (!SLUG_RE.test(n)) return true;
    if (n.includes("..")) return true;
    if (n === "." || n === "..") return true;
    if (n.endsWith(".git")) return true;
    if (n.includes("/") || n.includes("\\")) return true;
    return false;
  });

  const canSubmit = $derived(name.trim().length > 0 && !nameInvalid && !submitting);

  // Lazily enumerate the GitHub owners the first time the box is checked. Set the
  // guard before awaiting so a toggle storm can't fire overlapping requests, and so a
  // failed fetch (gh missing/unauthed) doesn't retry — it just degrades to no picker.
  $effect(() => {
    if (createRemote && !ownersLoaded) {
      ownersLoaded = true;
      getGithubOwners().then(({ login, orgs }) => {
        ownerLogin = login;
        ownerOrgs = orgs;
      });
    }
  });

  onMount(async () => {
    try {
      const { commands } = await getCommands("", { provider: "claude" });
      kickoffCommands = commands
        .filter((c) => commandProviders(c).includes("claude") && commandInsertable(c, "claude"))
        .map((c) => c.name.split(":").pop() ?? c.name)
        .filter((n) => KICKOFF_COMMANDS.has(n));
    } catch {
      // Fetch failure: silently fall back to PRD-only
      kickoffCommands = [];
    }
  });

  function msg(code: string): string {
    switch (code) {
      case "slug":
        return m.newproject_failed_slug();
      case "exists":
        return m.newproject_failed_exists();
      case "outside":
        return m.newproject_failed_outside();
      case "identity":
        return m.newproject_failed_identity();
      case "gh_missing":
        return m.newproject_failed_gh_missing();
      case "gh_auth":
        return m.newproject_failed_gh_auth();
      case "gh_exists":
        return m.newproject_failed_gh_exists();
      case "remote":
        return m.newproject_failed_remote();
      case "git":
        return m.newproject_failed_git();
      case "timeout":
        return m.newproject_failed_timeout();
      default:
        return m.newproject_failed_generic();
    }
  }

  function resolveKickoff(): KickoffChoice {
    if (kickoffValue === "__prd__") return { kind: "prd" };
    return { kind: "command", name: kickoffValue };
  }

  async function submit(e: Event) {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedIdea = idea.trim();
    if (!trimmedName || nameInvalid || submitting) return;
    submitting = true;
    error = null;
    retry = null;
    try {
      const entry = await createProject({
        name: trimmedName,
        idea: trimmedIdea,
        createRemote,
        visibility,
        owner: createRemote ? owner : "",
      });
      ondone(entry, resolveKickoff(), trimmedIdea);
    } catch (err) {
      const code = err instanceof Error ? err.message.replace(/^newproject_failed_/, "") : "";
      error = msg(code);
      retry = () => submit(e);
    } finally {
      submitting = false;
    }
  }
</script>

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
    aria-label={m.newproject_title()}
    use:dialog={{ onclose: () => onclose?.() }}
    onsubmit={submit}
  >
    <div class="chead">
      <span class="micro">{m.newproject_title()}</span>
      <button type="button" class="x" onclick={() => onclose?.()} aria-label={m.common_close()}
        >✕</button
      >
    </div>

    <!-- Name field -->
    <label class="micro" for="np-name">{m.newproject_name_label()}</label>
    <input
      id="np-name"
      type="text"
      bind:value={name}
      placeholder={m.newproject_name_placeholder()}
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      spellcheck={false}
    />

    {#if nameInvalid}
      <p class="field-err" role="alert">{m.newproject_name_invalid()}</p>
    {/if}

    {#if name && !nameInvalid}
      <p class="preview">
        {m.newproject_path_preview({ root: repoRootDisplay, name: name.trim() })}
      </p>
    {/if}

    <!-- Idea field -->
    <label class="micro" for="np-idea">{m.newproject_idea_label()}</label>
    <textarea
      id="np-idea"
      bind:value={idea}
      placeholder={m.newproject_idea_placeholder()}
      rows={3}
      autocomplete="off"
      autocapitalize="off"
      spellcheck={false}
      data-1p-ignore></textarea>

    <!-- GitHub checkbox -->
    <label class="check-row">
      <input type="checkbox" bind:checked={createRemote} />
      <span class="micro check-label">{m.newproject_github_label()}</span>
    </label>

    {#if createRemote}
      <div class="visibility-row" role="group" aria-label={m.newproject_visibility_group()}>
        <label class="vis-opt">
          <input type="radio" name="np-vis" value="private" bind:group={visibility} />
          <span class="micro">{m.newproject_visibility_private()}</span>
        </label>
        <label class="vis-opt">
          <input type="radio" name="np-vis" value="public" bind:group={visibility} />
          <span class="micro">{m.newproject_visibility_public()}</span>
        </label>
      </div>

      {#if ownerOrgs.length > 0}
        <label class="micro" for="np-owner">{m.newproject_owner_label()}</label>
        <select id="np-owner" bind:value={owner}>
          <option value="">{m.newproject_owner_personal({ login: ownerLogin ?? "" })}</option>
          {#each ownerOrgs as org (org)}
            <option value={org}>{org}</option>
          {/each}
        </select>
      {/if}
    {/if}

    <!-- Kickoff selection -->
    <label class="micro" for="np-kickoff">{m.newproject_kickoff_label()}</label>
    <select id="np-kickoff" bind:value={kickoffValue}>
      <option value="__prd__">{m.newproject_kickoff_prd()}</option>
      {#each kickoffCommands as cmd (cmd)}
        <option value={cmd}>/{cmd}</option>
      {/each}
    </select>

    {#if error}
      <div class="err" role="alert">
        <span>{error}</span>
        {#if retry}
          <button type="button" class="retry" onclick={() => retry?.()}>{m.common_retry()}</button>
        {/if}
      </div>
    {/if}

    <button class="run" type="submit" disabled={!canSubmit}>
      {submitting ? m.newproject_creating() : m.newproject_submit()}
    </button>
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
  input[type="text"],
  textarea,
  select {
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
  input[type="text"]:focus,
  textarea:focus,
  select:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }
  textarea {
    resize: vertical;
  }
  .preview {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 0;
    padding: 2px 0;
  }
  .field-err {
    font-size: var(--fs-meta);
    color: var(--color-red);
    margin: 0;
    padding: 2px 0;
  }
  .check-row {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    margin-top: 4px;
  }
  .check-label {
    margin-top: 0;
  }
  .visibility-row {
    display: flex;
    gap: 16px;
    padding-left: 4px;
  }
  .vis-opt {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }
  .vis-opt .micro {
    margin-top: 0;
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
    input[type="text"],
    textarea,
    select {
      /* 16px no-zoom font-size comes from the global iOS guard in app.css */
      min-height: 44px;
    }
    .run {
      min-height: 44px;
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
