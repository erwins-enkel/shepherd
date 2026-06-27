<script lang="ts">
  import { forkRepo } from "$lib/api";
  import type { RepoEntry } from "$lib/types";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";

  let {
    onclose,
    ondone,
    repoRootDisplay = "~/projects",
  }: {
    onclose?: () => void;
    ondone: (entry: RepoEntry) => void;
    repoRootDisplay?: string;
  } = $props();

  let target = $state("");
  let submitting = $state(false);
  let error = $state<string | null>(null);
  let retry = $state<(() => void) | null>(null);

  const targetName = $derived.by(() => {
    const segment = target.split("/").filter(Boolean).at(-1) ?? "";
    return segment.replace(/\.git$/i, "").trim();
  });

  function msg(code: string): string {
    switch (code) {
      case "auth":
        return m.forkrepo_failed_auth();
      case "exists":
        return m.forkrepo_failed_exists();
      case "url":
        return m.forkrepo_failed_url();
      case "outside":
        return m.forkrepo_failed_outside();
      case "timeout":
        return m.forkrepo_failed_timeout();
      case "gh_missing":
        return m.forkrepo_failed_gh_missing();
      default:
        return m.forkrepo_failed_generic();
    }
  }

  async function submit(e: Event) {
    e.preventDefault();
    if (!target.trim() || submitting) return;
    submitting = true;
    error = null;
    retry = null;
    try {
      const entry = await forkRepo(target.trim());
      ondone(entry);
    } catch (err) {
      const code = err instanceof Error ? err.message.replace(/^forkrepo_failed_/, "") : "";
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
    aria-label={m.forkrepo_title()}
    use:dialog={{ onclose: () => onclose?.() }}
    onsubmit={submit}
  >
    <div class="chead">
      <span class="micro">{m.forkrepo_title()}</span>
      <button type="button" class="x" onclick={() => onclose?.()} aria-label={m.common_close()}
        >✕</button
      >
    </div>

    <label class="micro" for="fr-target">{m.forkrepo_input_label()}</label>
    <input
      id="fr-target"
      type="text"
      bind:value={target}
      placeholder={m.forkrepo_input_placeholder()}
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      spellcheck={false}
      required
    />

    {#if targetName}
      <p class="preview">
        {m.forkrepo_target_preview({ root: repoRootDisplay, name: targetName })}
      </p>
    {/if}

    <p class="hint">{m.forkrepo_hint()}</p>

    {#if error}
      <div class="err" role="alert">
        <span>{error}</span>
        {#if retry}
          <button type="button" class="retry" onclick={() => retry?.()}>{m.common_retry()}</button>
        {/if}
      </div>
    {/if}

    <button class="run" type="submit" disabled={submitting}>
      {submitting ? m.forkrepo_forking() : m.forkrepo_submit()}
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
  .hint {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 4px 0 0;
    line-height: 1.5;
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
