<script lang="ts">
  import { onMount } from "svelte";
  import { listRepos, listBranches, uploadImage } from "$lib/api";
  import { MODELS, type RepoEntry } from "$lib/types";
  import RepoSelect from "./RepoSelect.svelte";
  import PromptSources from "./PromptSources.svelte";

  let {
    onsubmit,
    onclose,
    initialPrompt,
    initialRepoPath,
  }: {
    onsubmit: (input: {
      repoPath: string;
      baseBranch: string;
      prompt: string;
      model: string | null;
      images: string[];
    }) => Promise<void> | void;
    onclose?: () => void;
    initialPrompt?: string;
    initialRepoPath?: string;
  } = $props();

  // svelte-ignore state_referenced_locally -- intentional one-time seed; NewTask remounts per open
  let prompt = $state(initialPrompt ?? "");
  // svelte-ignore state_referenced_locally -- intentional one-time seed; NewTask remounts per open
  let repoPath = $state(initialRepoPath ?? "");
  let baseBranch = $state("main");
  let model = $state("default"); // "default" → claude's own model (no --model flag)
  let submitting = $state(false);
  let error = $state<string | null>(null);
  let repos = $state<RepoEntry[]>([]);
  let branches = $state<string[]>([]);
  let images = $state<{ path: string; name: string }[]>([]);
  let dragging = $state(false);
  let uploading = $state(false);
  let fileInput = $state<HTMLInputElement>();

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
    listRepos()
      .then((r) => {
        repos = r;
        if (!repoPath && r.length > 0) repoPath = defaultRepoPath(r);
      })
      .catch(() => {});
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

  async function addFiles(files: FileList | File[]) {
    const imgs = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (imgs.length === 0) return;
    uploading = true;
    error = null;
    try {
      for (const f of imgs) {
        const path = await uploadImage(f);
        images.push({ path, name: f.name });
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "upload failed";
    } finally {
      uploading = false;
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  }

  function removeImage(path: string) {
    images = images.filter((i) => i.path !== path);
  }

  async function submit(e: Event) {
    e.preventDefault();
    if (!prompt.trim() || !repoPath.trim() || submitting) return;
    submitting = true;
    error = null;
    try {
      await onsubmit({
        repoPath: repoPath.trim(),
        baseBranch: baseBranch.trim() || "main",
        prompt: prompt.trim(),
        model: model === "default" ? null : model,
        images: images.map((i) => i.path),
      });
    } catch (err) {
      error = err instanceof Error ? err.message : "failed";
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
  <form
    class="card bracket"
    class:dragging
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
      <span class="micro">New&nbsp;Task</span>
      <button type="button" class="x" onclick={() => onclose?.()} aria-label="close">✕</button>
    </div>

    <label class="micro" for="nt-prompt">Prompt</label>
    <textarea id="nt-prompt" bind:value={prompt} rows="3" placeholder="add a feature that…" required
    ></textarea>
    <div class="attach-row">
      <button type="button" class="attach" onclick={() => fileInput?.click()} disabled={uploading}>
        {uploading ? "Uploading…" : "📎 Attach image"}
      </button>
      <span class="hint">or drop screenshots here</span>
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
            <button type="button" class="chip-x" onclick={() => removeImage(img.path)} aria-label="remove">✕</button>
          </span>
        {/each}
      </div>
    {/if}

    {#if repoPath}
      <PromptSources {repoPath} onpick={(p) => (prompt = p)} />
    {/if}

    <label class="micro" for="nt-repo">Repo</label>
    <RepoSelect {repos} value={repoPath} onchange={(p) => (repoPath = p)} />

    <label class="micro" for="nt-base">Base&nbsp;Branch</label>
    {#if branches.length > 0}
      <select id="nt-base" bind:value={baseBranch}>
        {#each branches as b (b)}
          <option value={b}>{b}</option>
        {/each}
      </select>
    {:else}
      <input id="nt-base" bind:value={baseBranch} placeholder="main" />
    {/if}

    <label class="micro" for="nt-model">Model</label>
    <select id="nt-model" bind:value={model}>
      <option value="default">default</option>
      {#each MODELS as m (m)}
        <option value={m}>{m}</option>
      {/each}
    </select>

    {#if error}<div class="err">{error}</div>{/if}

    <button class="run" type="submit" disabled={submitting}>
      {submitting ? "Spawning…" : "Create & Run"}
    </button>
  </form>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(3, 6, 5, 0.66);
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
    font-size: 10.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
    margin-top: 6px;
  }
  textarea,
  input,
  select {
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: 13px;
    padding: 8px 10px;
    border-radius: 2px;
    resize: vertical;
  }
  select {
    appearance: none;
    cursor: pointer;
  }
  textarea:focus,
  input:focus,
  select:focus {
    outline: none;
    border-color: var(--color-amber);
  }
  .err {
    color: var(--color-red);
    font-size: 11.5px;
    margin-top: 6px;
  }
  .run {
    margin-top: 12px;
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    background: transparent;
    padding: 9px 14px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font: inherit;
    font-size: 11px;
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
    textarea,
    input,
    select {
      font-size: 16px; /* prevents iOS zoom-on-focus */
    }
    input,
    select,
    .run {
      min-height: 44px;
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
    font-size: 11px;
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
    font-size: 10.5px;
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
    font-size: 11px;
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
  @media (max-width: 768px) {
    .attach {
      min-height: 44px;
    }
  }
</style>
