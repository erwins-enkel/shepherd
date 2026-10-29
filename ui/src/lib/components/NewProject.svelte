<script lang="ts">
  import { createProject, getCommands, getGithubOwners } from "#lib/api.js";
  import type { RepoEntry } from "#lib/types.js";
  import { dialog } from "#lib/a11yDialog.js";
  import { m } from "#lib/paraglide/messages.js";
  import { commandInsertable, commandProviders } from "#lib/slash.js";
  import { onMount } from "svelte";
  import NewProjectDocsPicker from "./new-project/NewProjectDocsPicker.svelte";
  import {
    docsOverCap,
    emptyDocs,
    filesFromDrop,
    mergeDocs,
    sortDropped,
    type AttachedDocs,
  } from "./new-project/project-docs";

  // Slug rule mirrors src/validate.ts PROJECT_SLUG_RE exactly.
  // Cross-reference: keep both patterns in sync when either changes.
  const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;

  // Idea cap mirrors src/validate.ts parseIdeaField() (trimmed length).
  // Cross-reference: keep both limits in sync when either changes.
  const IDEA_MAX = 8000;

  // Curated allow-list of kickoff command bare names (strip plugin: prefix).
  const KICKOFF_COMMANDS = new Set([
    "gsd-new-project",
    "impeccable",
    "create_plan",
    "gsd-explore",
    "shaping",
  ]);

  export type KickoffChoice =
    | { kind: "prd"; prdSupplied?: boolean }
    | { kind: "bootstrap" }
    | { kind: "command"; name: string };

  let {
    onclose,
    ondone,
    repoRootDisplay = "~/projects",
  }: {
    onclose?: () => void;
    /** `customize`: "Create & adjust before starting" — the first session waits for the operator
     *  instead of starting by itself. */
    ondone: (
      entry: RepoEntry & { warning?: string },
      kickoff: KickoffChoice,
      idea: string,
      customize: boolean,
    ) => void;
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
  // "__bootstrap__" → { kind: "bootstrap" } (#3112, the default since #3420), "__prd__" →
  // { kind: "prd" }, any other value → { kind: "command", name: value }.
  let kickoffValue = $state<string>("__bootstrap__");
  let kickoffCommands = $state<string[]>([]);
  // The PRD + design export attached in the Idea field or dropped on the dialog (#3112, #3420).
  // Sent with the create whatever the kickoff: it lands in docs/prd + docs/design.
  let docs = $state<AttachedDocs>(emptyDocs());
  let dragging = $state(false);
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

  const ideaLength = $derived(idea.trim().length);
  const ideaTooLong = $derived(ideaLength > IDEA_MAX);

  const docsTooBig = $derived(docsOverCap(docs));

  const canSubmit = $derived(
    name.trim().length > 0 && !nameInvalid && !ideaTooLong && !docsTooBig && !submitting,
  );

  const kickoffLabel = $derived.by(() => {
    if (kickoffValue === "__bootstrap__") return m.newproject_kickoff_bootstrap();
    if (kickoffValue === "__prd__") return m.newproject_kickoff_prd();
    return `/${kickoffValue}`;
  });

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
      // Fetch failure: the select falls back to the built-in kickoffs only
      kickoffCommands = [];
    }
  });

  function msg(code: string): string {
    switch (code) {
      case "slug":
        return m.newproject_failed_slug();
      case "idea_too_long":
        return m.newproject_failed_idea_too_long({ max: IDEA_MAX });
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
      case "docs":
        return m.newproject_failed_docs();
      case "docs_size":
        return m.newproject_failed_docs_size();
      default:
        return m.newproject_failed_generic();
    }
  }

  function resolveKickoff(): KickoffChoice {
    if (kickoffValue === "__prd__")
      return docs.prd.length > 0 ? { kind: "prd", prdSupplied: true } : { kind: "prd" };
    if (kickoffValue === "__bootstrap__") return { kind: "bootstrap" };
    return { kind: "command", name: kickoffValue };
  }

  // #3420: the whole dialog is the drop target, so a near-miss on the scrim never makes the
  // browser open the file. Text drags pass untouched — they still drop into the textarea.
  const draggingFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;

  function onDragOver(e: DragEvent) {
    if (!draggingFiles(e)) return;
    e.preventDefault();
    dragging = true;
  }

  function onDragLeave(e: DragEvent) {
    if (!(e.currentTarget as Node).contains(e.relatedTarget as Node | null)) dragging = false;
  }

  async function onDrop(e: DragEvent) {
    if (!e.dataTransfer || !draggingFiles(e)) return;
    e.preventDefault();
    dragging = false;
    // A create is in flight: a retry must resend the file set that failed.
    if (submitting) return;
    // A new attempt retires the previous drop's failure; any other error stays.
    if (error === m.newproject_drop_failed()) error = null;
    // Captured before the first await: the drop's items are gone once the handler returns.
    const pending = filesFromDrop(e.dataTransfer);
    try {
      docs = mergeDocs(docs, sortDropped(await pending));
    } catch {
      error = m.newproject_drop_failed();
      retry = null;
    }
  }

  async function submit(e: Event, customize = false) {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedIdea = idea.trim();
    if (!canSubmit) return;
    submitting = true;
    error = null;
    retry = null;
    try {
      const entry = await createProject(
        {
          name: trimmedName,
          idea: trimmedIdea,
          createRemote,
          visibility,
          owner: createRemote ? owner : "",
        },
        docs,
      );
      ondone(entry, resolveKickoff(), trimmedIdea, customize);
    } catch (err) {
      const code = err instanceof Error ? err.message.replace(/^newproject_failed_/, "") : "";
      error = msg(code);
      retry = () => submit(e, customize);
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
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
>
  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
  <form
    class="card bracket"
    class:dragging
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

    <!-- Idea field: a composer with the PRD/design attachments in its toolbar (#3420). -->
    <label class="micro" for="np-idea">{m.newproject_idea_label()}</label>
    <div class="composer">
      <textarea
        id="np-idea"
        bind:value={idea}
        placeholder={m.newproject_idea_placeholder()}
        rows={3}
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        aria-describedby="np-idea-count"
        aria-invalid={ideaTooLong}
        data-1p-ignore></textarea>
      <NewProjectDocsPicker
        bind:docs
        count={m.newproject_idea_count({ count: ideaLength, max: IDEA_MAX })}
        countOver={ideaTooLong}
      />
    </div>
    {#if ideaTooLong}
      <p class="field-err" role="alert">{m.newproject_failed_idea_too_long({ max: IDEA_MAX })}</p>
    {/if}
    {#if docs.prd.length + docs.design.length > 0}
      <p class="preview">
        {m.newproject_docs_summary({ prd: docs.prd.length, design: docs.design.length })}
      </p>
      {#if docsTooBig}
        <p class="field-err" role="alert">{m.newproject_failed_docs_size()}</p>
      {:else if kickoffValue === "__bootstrap__"}
        <p class="preview">{m.newproject_docs_bootstrap_note()}</p>
      {/if}
    {/if}

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

    <!-- Kickoff selection: Bootstrap is the default, so the choice folds away (#3420). -->
    <details class="advanced">
      <summary class="micro">{m.newproject_advanced_summary({ choice: kickoffLabel })}</summary>
      <div class="advanced-body">
        <label class="micro" for="np-kickoff">{m.newproject_kickoff_label()}</label>
        <select id="np-kickoff" bind:value={kickoffValue}>
          <option value="__bootstrap__">{m.newproject_kickoff_bootstrap()}</option>
          <option value="__prd__">{m.newproject_kickoff_prd()}</option>
          {#each kickoffCommands as cmd (cmd)}
            <option value={cmd}>/{cmd}</option>
          {/each}
        </select>
      </div>
    </details>

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
    <button
      class="gbtn customize"
      type="button"
      disabled={!canSubmit}
      onclick={(e) => submit(e, true)}
    >
      {m.newproject_submit_customize()}
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
  .card.dragging {
    border-color: var(--color-amber);
    box-shadow: inset 0 0 30px -16px var(--color-amber);
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
  select,
  .composer {
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    width: 100%;
    box-sizing: border-box;
  }
  input[type="text"],
  textarea,
  select {
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    padding: 8px 10px;
  }
  input[type="text"]:focus,
  select:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }
  /* The composer's border is the field's: the textarea inside has none of its own. */
  .composer:focus-within {
    border-color: var(--color-line-bright);
  }
  textarea {
    display: block;
    width: 100%;
    box-sizing: border-box;
    background: transparent;
    border: 0;
    resize: vertical;
  }
  textarea:focus {
    outline: none;
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
  .advanced summary {
    width: fit-content;
    cursor: pointer;
  }
  .advanced summary:hover {
    color: var(--color-ink-bright);
  }
  .advanced summary:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .advanced-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
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
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .customize {
    align-self: center;
    margin-top: 4px;
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
    /* The corner brackets sit 1px outside the card: on the borderless full-screen sheet they would
       only add a sideways scroll (same as CodexUpdateModal / HerdrUpdateModal). */
    .bracket::before,
    .bracket::after {
      display: none;
    }
    input[type="text"],
    textarea,
    select {
      /* 16px no-zoom font-size comes from the global iOS guard in app.css */
      min-height: 44px;
    }
    .run,
    .customize {
      min-height: 44px;
    }
    /* Padding, not flex: a flex summary would lose its native disclosure marker. */
    .advanced summary {
      min-height: 44px;
      box-sizing: border-box;
      padding: 12px 0;
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
