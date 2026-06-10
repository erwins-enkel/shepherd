<script lang="ts">
  import { onMount } from "svelte";
  import { listRepos, listBranches, getCommands, uploadImage } from "$lib/api";
  import { handleImagePaste } from "$lib/clipboard";
  import { MODELS, type Issue, type IssueRef, type RepoEntry, type SlashCommand } from "$lib/types";
  import { promoDefaultModel } from "$lib/fable-promo";
  import { matchSlashTrigger, filterCommands, applyCommandPick } from "$lib/slash";
  import RepoSelect from "./RepoSelect.svelte";
  import PromptSources from "./PromptSources.svelte";
  import SlashCommandMenu from "./SlashCommandMenu.svelte";
  import { dialog } from "$lib/a11yDialog";
  import { repoConfig } from "$lib/reviews.svelte";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import { m } from "$lib/paraglide/messages";

  let {
    onsubmit,
    onclose,
    onclone,
    onnewproject,
    initialPrompt,
    initialRepoPath,
    initialIssue,
    initialModel,
    defaultModel,
  }: {
    onsubmit: (input: {
      repoPath: string;
      baseBranch: string;
      prompt: string;
      model: string | null;
      images: string[];
      issueRef?: IssueRef;
      planGateEnabled: boolean;
    }) => Promise<void> | void;
    onclose?: () => void;
    onclone?: () => void;
    onnewproject?: () => void;
    initialPrompt?: string;
    initialRepoPath?: string;
    initialIssue?: Issue;
    initialModel?: string;
    defaultModel?: string;
  } = $props();

  /** Short editable seed so the user only adds deltas; the body rides out-of-band. */
  function issueTemplate(issue: Issue): string {
    return m.newtask_issue_prompt_template({ number: issue.number, title: issue.title });
  }

  // intentional one-time seed; NewTask remounts per open
  // svelte-ignore state_referenced_locally
  let prompt = $state(initialPrompt ?? (initialIssue ? issueTemplate(initialIssue) : ""));
  // The attached issue: its body is sent separately, NOT dumped into the prompt.
  // svelte-ignore state_referenced_locally
  let issueRef = $state<Issue | null>(initialIssue ?? null);
  // intentional one-time seed; NewTask remounts per open
  // svelte-ignore state_referenced_locally
  let repoPath = $state(initialRepoPath ?? "");
  let baseBranch = $state("main");
  // Picker preselect precedence: explicit initialModel (e.g. the "Try Fable" CTA) wins;
  // else the operator's configured default if it's an explicit model; else the fresh
  // client promo (configured "auto", or settings not yet loaded). Resolved at mount,
  // and NewTask remounts per open, so the promo cutoff is honored fresh each open.
  function preselectModel(configured: string | undefined): string {
    return configured && configured !== "auto" ? configured : promoDefaultModel();
  }
  // svelte-ignore state_referenced_locally
  let model = $state(initialModel ?? preselectModel(defaultModel));
  // Plan gate: defaults to the selected repo's stored flag until the user toggles
  // it. `planGateTouched` pins a manual choice so switching repos doesn't clobber it.
  let planGate = $state(false);
  let planGateTouched = $state(false);
  let submitting = $state(false);
  let error = $state<string | null>(null);
  // re-invokes whichever action last failed (upload or create) from an inline Retry
  let retry = $state<(() => void) | null>(null);

  function reason(e: unknown, fallback: string): string {
    const msg = e instanceof Error ? e.message.trim() : "";
    return msg || fallback;
  }
  let repos = $state<RepoEntry[]>([]);
  // Day count the server computed recentAgentCount over; drives the picker's label.
  // 0 until listRepos() resolves — the recents group (and its label) only render
  // once repo data has loaded, which sets this from the server in the same step,
  // so the sentinel is never shown and there's no duplicated window literal.
  let recentRepoWindowDays = $state(0);
  // Echoed on the submit button so the destination repo is visible at commit time.
  const selectedRepoName = $derived(repos.find((r) => r.path === repoPath)?.name ?? "");
  let branches = $state<string[]>([]);
  let images = $state<{ path: string; name: string }[]>([]);
  let dragging = $state(false);
  let uploading = $state(false);
  let fileInput = $state<HTMLInputElement>();
  let promptInput = $state<HTMLTextAreaElement>();
  let isMac = $state(false);

  // ── inline slash-command autocomplete (reuses the /api/commands index) ──
  let allCommands = $state<SlashCommand[]>([]);
  let slashOpen = $state(false);
  let slashQuery = $state("");
  let slashIndex = $state(0);
  const slashMatches = $derived(slashOpen ? filterCommands(allCommands, slashQuery) : []);

  /** Default to the most-recently-used repo; fall back to the first in the list. */
  function defaultRepoPath(list: RepoEntry[]): string {
    let best: RepoEntry | undefined;
    for (const r of list) {
      if (r.lastUsedAt != null && (best?.lastUsedAt == null || r.lastUsedAt > best.lastUsedAt)) {
        best = r;
      }
    }
    return best?.path ?? list[0]?.path ?? "";
  }

  onMount(() => {
    isMac = /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
    listRepos()
      .then(({ repos: r, recentWindowDays }) => {
        repos = r;
        recentRepoWindowDays = recentWindowDays;
        if (!repoPath && r.length > 0) repoPath = defaultRepoPath(r);
      })
      .catch(() => {});
    // Focus the prompt so the user can type immediately when the dialog opens.
    // Move the caret to the end so a seeded initialPrompt stays editable inline.
    promptInput?.focus();
    promptInput?.setSelectionRange(prompt.length, prompt.length);
    autogrow(); // size to a seeded initialPrompt on open
    // Paste anywhere in the modal (the textarea need not be focused first).
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  // load branches for the selected repo; reset base to the repo's current branch
  $effect(() => {
    const rp = repoPath;
    if (!rp) {
      branches = [];
      return;
    }
    listBranches(rp)
      .then((b) => {
        if (rp !== repoPath) return;
        branches = b.branches;
        baseBranch = b.current ?? b.branches[0] ?? "main";
      })
      .catch(() => {
        branches = [];
      });
  });

  // Seed the plan-gate checkbox from the selected repo's stored default. ensure()
  // fetches+caches the repo config; the derived default below tracks the cached
  // flag and re-seeds the checkbox on repo change unless the user has toggled it.
  $effect(() => {
    if (repoPath) repoConfig.ensure(repoPath);
  });
  const planGateDefault = $derived(repoPath ? repoConfig.isPlanGateEnabled(repoPath) : false);
  $effect(() => {
    // mirror the repo default until the user makes a manual choice
    if (!planGateTouched) planGate = planGateDefault;
  });

  // (re)load the slash-command list when the target repo changes — a repo's own
  // .claude/commands + .claude/skills layer on top of the global/user/plugin ones.
  $effect(() => {
    const rp = repoPath;
    if (!rp) {
      allCommands = [];
      return;
    }
    getCommands(rp)
      .then((r) => {
        if (rp === repoPath) allCommands = r.commands;
      })
      .catch(() => {
        if (rp === repoPath) allCommands = [];
      });
  });

  async function addFiles(files: FileList | File[]) {
    const imgs = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (imgs.length === 0) return;
    uploading = true;
    error = null;
    retry = null;
    try {
      for (const f of imgs) {
        const path = await uploadImage(f);
        images.push({ path, name: f.name });
      }
    } catch (err) {
      error = m.newtask_upload_failed({ reason: reason(err, m.newtask_attach_image()) });
      retry = () => addFiles(imgs);
    } finally {
      uploading = false;
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  }

  // Cmd/Ctrl+V of a screenshot: upload any image on the clipboard. A plain-text
  // paste carries no image item, so handleImagePaste leaves it alone.
  function onPaste(e: ClipboardEvent) {
    handleImagePaste(e, addFiles);
  }

  function removeImage(path: string) {
    images = images.filter((i) => i.path !== path);
  }

  // Attach an issue by reference: keep the body off the prompt (it rides out-of-band
  // to the agent), seed an editable template only when the user hasn't typed anything.
  function pickIssue(issue: Issue) {
    issueRef = issue;
    if (!prompt.trim()) {
      prompt = issueTemplate(issue);
      queueMicrotask(autogrow);
    }
  }

  // Grow the prompt with its content (capped by CSS max-height, then it scrolls).
  // iOS Safari has no usable resize handle, so auto-grow is how the field gets bigger.
  function autogrow() {
    if (!promptInput) return;
    promptInput.style.height = "auto";
    promptInput.style.height = `${promptInput.scrollHeight}px`;
  }

  // Open/refresh the slash menu from the caret position, or close it when the text
  // before the caret is no longer a leading `/token`.
  function refreshSlash() {
    const caret = promptInput?.selectionStart ?? prompt.length;
    const trigger = matchSlashTrigger(prompt, caret);
    if (trigger) {
      slashOpen = true;
      slashQuery = trigger.query;
      slashIndex = 0;
    } else {
      slashOpen = false;
    }
  }

  function onPromptInput() {
    autogrow();
    refreshSlash();
  }

  // Replace the typed `/query` token with the chosen command and hoist it to the
  // front of the prompt — Claude only runs a *leading* slash command, so a command
  // typed mid-text becomes the leading command with the surrounding text as its
  // argument. Caret lands past `/name ` so the user can type arguments straight away.
  function pickCommand(cmd: SlashCommand) {
    const caret = promptInput?.selectionStart ?? prompt.length;
    const start = matchSlashTrigger(prompt, caret)?.start ?? 0;
    const next = applyCommandPick(prompt, start, caret, cmd.name);
    prompt = next.value;
    slashOpen = false;
    queueMicrotask(() => {
      autogrow();
      promptInput?.focus();
      promptInput?.setSelectionRange(next.caret, next.caret);
    });
  }

  // Cmd/Ctrl+Enter submits (plain Enter inserts a newline). While the slash menu is
  // open it captures the navigation keys so arrows/Enter/Tab drive the picker.
  function onPromptKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submit(e);
      return;
    }
    if (slashOpen && slashMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        slashIndex = (slashIndex + 1) % slashMatches.length;
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        slashIndex = (slashIndex - 1 + slashMatches.length) % slashMatches.length;
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickCommand(slashMatches[slashIndex]!);
      } else if (e.key === "Escape") {
        e.preventDefault();
        slashOpen = false;
      }
    } else if (slashOpen && e.key === "Escape") {
      e.preventDefault();
      slashOpen = false;
    }
  }

  async function submit(e: Event) {
    e.preventDefault();
    if (!prompt.trim() || !repoPath.trim() || submitting) return;
    submitting = true;
    error = null;
    retry = null;
    try {
      await onsubmit({
        repoPath: repoPath.trim(),
        baseBranch: baseBranch.trim() || "main",
        prompt: prompt.trim(),
        model: model === "default" ? null : model,
        images: images.map((i) => i.path),
        issueRef: issueRef
          ? {
              number: issueRef.number,
              url: issueRef.url,
              title: issueRef.title,
              body: issueRef.body,
            }
          : undefined,
        planGateEnabled: planGate,
      });
    } catch (err) {
      error = m.newtask_create_failed({ reason: reason(err, m.newtask_submit()) });
      retry = () => submit(e);
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
  <!-- The modal card is a <form> so the prompt submits natively; role="dialog"
       on it is valid ARIA (a dialog whose content is a form). Svelte's
       non-interactive→interactive-role heuristic flags <form>, so silence just
       that one rule here. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
  <form
    class="card bracket"
    class:dragging
    role="dialog"
    aria-modal="true"
    aria-label={m.newtask_title()}
    use:dialog={{ onclose: () => onclose?.() }}
    onsubmit={submit}
    ondragover={(e) => {
      e.preventDefault();
      dragging = true;
    }}
    ondragleave={(e) => {
      if (e.target === e.currentTarget) dragging = false;
    }}
    ondrop={onDrop}
  >
    <div class="chead">
      <span class="micro">{m.newtask_title()}</span>
      <button type="button" class="x" onclick={() => onclose?.()} aria-label={m.common_close()}
        >✕</button
      >
    </div>

    <div class="repo-field" use:coachTarget={"nt-repo"}>
      <label class="micro" for="nt-repo">{m.newtask_repo_label()}</label>
      <RepoSelect
        {repos}
        windowDays={recentRepoWindowDays}
        value={repoPath}
        onchange={(p) => (repoPath = p)}
        {onclone}
        {onnewproject}
      />
    </div>

    <label class="micro" for="nt-prompt">{m.newtask_prompt_label()}</label>
    <div class="prompt-wrap">
      <textarea
        id="nt-prompt"
        bind:this={promptInput}
        bind:value={prompt}
        rows="3"
        placeholder={m.newtask_prompt_placeholder()}
        oninput={onPromptInput}
        onkeydown={onPromptKeydown}
        onblur={() => (slashOpen = false)}
        required
      ></textarea>
      {#if slashOpen}
        <SlashCommandMenu
          commands={slashMatches}
          activeIndex={slashIndex}
          onpick={pickCommand}
          onhover={(i) => (slashIndex = i)}
        />
      {/if}
    </div>
    <div class="attach-row">
      <button type="button" class="attach" onclick={() => fileInput?.click()} disabled={uploading}>
        {uploading ? m.newtask_uploading() : m.newtask_attach_image()}
      </button>
      <span class="hint">{m.newtask_drop_hint()}</span>
    </div>
    <input
      bind:this={fileInput}
      type="file"
      accept="image/*"
      multiple
      hidden
      onchange={(e) => {
        const t = e.currentTarget;
        if (t.files) addFiles(t.files);
        t.value = "";
      }}
    />
    {#if images.length > 0}
      <div class="chips">
        {#each images as img (img.path)}
          <span class="chip">
            <span class="chip-name">{img.name}</span>
            <button
              type="button"
              class="chip-x"
              onclick={() => removeImage(img.path)}
              aria-label={m.newtask_remove_image_aria()}>✕</button
            >
          </span>
        {/each}
      </div>
    {/if}

    {#if issueRef}
      <div class="issue-ref">
        <span class="issue-ref-label">{m.newtask_issue_attached_label()}</span>
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external GitHub URL -->
        <a class="issue-ref-link" href={issueRef.url} target="_blank" rel="noopener"
          >#{issueRef.number} {issueRef.title}</a
        >
        <button
          type="button"
          class="issue-ref-x"
          onclick={() => (issueRef = null)}
          aria-label={m.newtask_issue_remove_aria()}>✕</button
        >
      </div>
    {/if}

    {#if repoPath}
      <PromptSources
        {repoPath}
        onpick={(p) => {
          prompt = p;
          // resize, then land focus + caret at the end so a seeded command like
          // "/merge-train " is immediately editable for args
          queueMicrotask(() => {
            autogrow();
            promptInput?.focus();
            promptInput?.setSelectionRange(prompt.length, prompt.length);
          });
        }}
        onpickissue={pickIssue}
      />
    {/if}

    <label class="micro" for="nt-base">{m.newtask_branch_label()}</label>
    {#if branches.length > 0}
      <select id="nt-base" bind:value={baseBranch}>
        {#each branches as b (b)}
          <option value={b}>{b}</option>
        {/each}
      </select>
    {:else}
      <input id="nt-base" bind:value={baseBranch} placeholder={m.newtask_branch_placeholder()} />
    {/if}

    <!-- Both are per-task run settings: plan-gate takes the primary slot,
         the model select sits compact beside it on desktop (stacked on phones). -->
    <div class="opts-row">
      <label class="plan-gate" use:coachTarget={"plan-gate"} title={m.newtask_plan_gate_hint()}>
        <input type="checkbox" bind:checked={planGate} onchange={() => (planGateTouched = true)} />
        <span class="pg-text">
          <span class="pg-label">{m.newtask_plan_gate_label()}</span>
          <span class="pg-hint">{m.newtask_plan_gate_hint()}</span>
        </span>
      </label>

      <div class="model-field">
        <label class="micro" for="nt-model">{m.newtask_model_label()}</label>
        <select id="nt-model" bind:value={model}>
          <option value="default">{m.newtask_model_default()}</option>
          {#each MODELS as mdl (mdl)}
            <option value={mdl}>{mdl}</option>
          {/each}
        </select>
      </div>
    </div>

    {#if error}
      <div class="err" role="alert">
        <span>{error}</span>
        {#if retry}
          <button type="button" class="retry" onclick={() => retry?.()}>{m.common_retry()}</button>
        {/if}
      </div>
    {/if}

    <button
      class="run"
      type="submit"
      disabled={submitting}
      title={isMac ? "⌘ + Enter" : "Ctrl + Enter"}
    >
      <span
        >{submitting
          ? m.newtask_spawning()
          : selectedRepoName
            ? m.newtask_submit_in_repo({ repo: selectedRepoName })
            : m.newtask_submit()}</span
      >
      {#if !submitting}
        <kbd class="kbd">{isMac ? "⌘↵" : "Ctrl+↵"}</kbd>
      {/if}
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
    z-index: 20;
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
  .repo-field {
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
  .prompt-wrap {
    position: relative;
  }
  textarea,
  input,
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
  textarea {
    /* JS auto-grows the height with content; cap it here and then scroll,
       so a long prompt never pushes the rest of the form off-screen.
       No native resize handle — iOS Safari doesn't render it reliably. */
    resize: none;
    max-height: 50vh;
    overflow-y: auto;
  }
  select {
    appearance: none;
    cursor: pointer;
  }
  textarea:focus,
  input:focus,
  select:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }
  .opts-row {
    /* flex-start: plan-gate label and MODEL caption share a top edge */
    display: flex;
    align-items: flex-start;
    gap: 14px;
    margin-top: 10px;
  }
  .plan-gate {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    cursor: pointer;
  }
  .model-field {
    flex: 0 0 180px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .model-field .micro {
    margin-top: 0;
  }
  .plan-gate input {
    width: auto;
    margin-top: 2px;
    flex: 0 0 auto;
    accent-color: var(--color-amber);
  }
  .pg-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .pg-label {
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
  }
  .pg-hint {
    color: var(--color-muted);
    font-size: var(--fs-meta);
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
  .run span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .run:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    color: var(--color-faint);
    border-color: var(--color-line);
    box-shadow: none;
  }
  .kbd {
    flex-shrink: 0;
    font: inherit;
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
    text-transform: none;
    color: var(--color-amber);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    padding: 1px 5px;
    opacity: 0.75;
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
    /* 16px no-zoom font-size for textarea/input/select comes from the global
       iOS guard in app.css */
    input,
    select,
    .run {
      min-height: 44px;
    }
    /* Compact head on phones: the "New Task" title is redundant once the
       sheet is open and the prompt label is obvious from the placeholder.
       Drop both, leaving a single 44px row that holds only the close ✕ in the
       top-right corner — in flow so it stays aligned with the inset fields
       below rather than floating, detached, over the prompt. */
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
      margin-right: -10px; /* nudge the glyph toward the sheet edge */
      font-size: var(--fs-lg);
    }
    label[for="nt-prompt"] {
      display: none;
    }
    textarea {
      /* Inset like every other field (REPO/BRANCH/MODEL) so the border stays
         within the viewport. The earlier full-bleed breakout (negative margin +
         calc width) pushed the border past the edge and left the ✕ visually
         detached. Comfortable starting size; auto-grow takes it up to 40dvh,
         then scrolls. */
      min-height: 120px;
      max-height: 40dvh;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
    }
    /* Stack the run settings again on phones — the sheet is too narrow for
       the side-by-side row. */
    .opts-row {
      flex-direction: column;
      align-items: stretch;
      gap: 10px;
    }
    .model-field {
      flex: none;
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
  .card.dragging {
    border-color: var(--color-amber);
    box-shadow: inset 0 0 30px -16px var(--color-amber);
  }
  .attach-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
  }
  .attach {
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    padding: 6px 10px;
    border-radius: 2px;
    cursor: pointer;
  }
  .attach:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .hint {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 3px 7px;
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  .chip-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 22ch;
  }
  .chip-x {
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
    line-height: 1;
  }
  .issue-ref {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
    padding: 6px 8px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-inset);
    font-size: var(--fs-meta);
  }
  .issue-ref-label {
    flex-shrink: 0;
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-faint);
  }
  .issue-ref-link {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-amber);
    text-decoration: none;
  }
  .issue-ref-link:hover {
    text-decoration: underline;
  }
  .issue-ref-x {
    flex-shrink: 0;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
    line-height: 1;
  }
  @media (max-width: 768px) {
    .attach {
      min-height: 44px;
    }
  }
</style>
