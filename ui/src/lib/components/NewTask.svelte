<script lang="ts">
  let {
    onsubmit,
    onclose,
  }: {
    onsubmit: (input: { repoPath: string; baseBranch: string; prompt: string }) => Promise<void> | void;
    onclose?: () => void;
  } = $props();

  let prompt = $state("");
  let repoPath = $state("");
  let baseBranch = $state("main");
  let submitting = $state(false);
  let error = $state<string | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    if (!prompt.trim() || !repoPath.trim() || submitting) return;
    submitting = true;
    error = null;
    try {
      await onsubmit({ repoPath: repoPath.trim(), baseBranch: baseBranch.trim() || "main", prompt: prompt.trim() });
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
  <form class="card bracket" onsubmit={submit}>
    <div class="chead">
      <span class="micro">New&nbsp;Task</span>
      <button type="button" class="x" onclick={() => onclose?.()} aria-label="close">✕</button>
    </div>

    <label class="micro" for="nt-prompt">Prompt</label>
    <textarea id="nt-prompt" bind:value={prompt} rows="3" placeholder="add a feature that…" required
    ></textarea>

    <label class="micro" for="nt-repo">Repo&nbsp;Path</label>
    <input id="nt-repo" bind:value={repoPath} placeholder="~/Work/…" required />

    <label class="micro" for="nt-base">Base&nbsp;Branch</label>
    <input id="nt-base" bind:value={baseBranch} placeholder="main" />

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
  input {
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: 13px;
    padding: 8px 10px;
    border-radius: 2px;
    resize: vertical;
  }
  textarea:focus,
  input:focus {
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
</style>
