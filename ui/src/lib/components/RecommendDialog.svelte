<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { dialog } from "$lib/a11yDialog";
  import { portal } from "$lib/portal";
  import { recommendPrompt, replySession } from "$lib/api";
  import { modelLabel } from "$lib/model-label";
  import type { AgentProvider } from "$lib/types";

  // Modal that runs a next-prompt recommendation for one session and surfaces the
  // result as a copyable / injectable prompt. A blocking dialog (the operator reads
  // and acts on the suggestion), so it uses the canonical .overlay backdrop (dim +
  // blur from app.css). Loading / result / error are distinct states — the analysis
  // spawns a real second agent and can take a while, so we never strand on a spinner.
  let {
    sessionId,
    provider,
    model,
    onclose,
  }: {
    sessionId: string;
    provider: AgentProvider;
    model: string;
    onclose: () => void;
  } = $props();

  type Phase =
    { kind: "loading" } | { kind: "result"; prompt: string } | { kind: "error"; code: string };

  let phase = $state<Phase>({ kind: "loading" });
  let copied = $state(false);
  let injected = $state(false);
  let injectFailed = $state(false);

  async function run() {
    phase = { kind: "loading" };
    copied = false;
    injected = false;
    injectFailed = false;
    const r = await recommendPrompt(sessionId, provider, model);
    phase = "prompt" in r ? { kind: "result", prompt: r.prompt } : { kind: "error", code: r.error };
  }

  // Kick off the analysis on mount.
  $effect(() => {
    void run();
  });

  function errorMessage(code: string): string {
    switch (code) {
      case "no-history":
        return m.recommend_err_no_history();
      case "spawn-failed":
        return m.recommend_err_spawn_failed();
      case "unavailable":
        return m.recommend_err_unavailable();
      default:
        return m.recommend_err_timeout();
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // clipboard blocked (insecure context / denied) — fail quietly; the text is
      // still selectable in the field for manual copy.
    }
  }

  async function inject(text: string) {
    injectFailed = false;
    try {
      await replySession(sessionId, text);
      injected = true;
      setTimeout(onclose, 700);
    } catch {
      injectFailed = true;
    }
  }
</script>

<div
  class="overlay"
  role="presentation"
  use:portal
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    class="card"
    role="dialog"
    aria-modal="true"
    aria-label={m.recommend_title()}
    use:dialog={{ onclose }}
  >
    <div class="chead">
      <span class="micro">{m.recommend_title()} · {modelLabel(model)}</span>
      <button type="button" class="x" onclick={onclose} aria-label={m.common_close()}>✕</button>
    </div>

    {#if phase.kind === "loading"}
      <div class="state" role="status" aria-live="polite">
        <span class="spinner" aria-hidden="true"></span>
        <div class="state-text">
          <div>{m.recommend_loading()}</div>
          <div class="hint">{m.recommend_loading_hint()}</div>
        </div>
      </div>
    {:else if phase.kind === "error"}
      <div class="state error" role="alert">
        <div class="state-text">{errorMessage(phase.code)}</div>
      </div>
      <div class="foot">
        <button type="button" class="gbtn" onclick={() => void run()}>{m.common_retry()}</button>
        <button type="button" class="gbtn ghost" onclick={onclose}>{m.common_close()}</button>
      </div>
    {:else}
      <span class="micro">{m.recommend_result_hint()}</span>
      <textarea
        class="prompt"
        readonly
        rows="6"
        aria-label={m.recommend_result_hint()}
        value={phase.prompt}></textarea>
      {#if injectFailed}
        <div class="inline-err" role="alert">{m.recommend_inject_failed()}</div>
      {/if}
      <div class="foot">
        <button
          type="button"
          class="gbtn"
          onclick={() => copy((phase as { prompt: string }).prompt)}
        >
          {copied ? m.recommend_copied() : m.recommend_copy()}
        </button>
        <button
          type="button"
          class="gbtn primary"
          disabled={injected}
          onclick={() => void inject((phase as { prompt: string }).prompt)}
        >
          {injected ? m.recommend_injected() : m.recommend_inject()}
        </button>
        <button type="button" class="gbtn ghost" onclick={onclose}>{m.common_close()}</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--color-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 60;
    padding: 16px;
  }
  .card {
    width: min(560px, 94vw);
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    border-radius: 3px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  }
  .chead {
    display: flex;
    align-items: center;
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
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .state {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 2px;
  }
  .state-text {
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
  }
  .state.error .state-text {
    color: var(--color-red);
  }
  .hint {
    margin-top: 3px;
    color: var(--color-faint);
    font-size: var(--fs-meta);
  }
  .spinner {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    border: 2px solid var(--color-line-bright);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation-duration: 2.4s;
    }
  }
  .prompt {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    min-height: 96px;
    max-height: 40vh;
    overflow-y: auto;
    padding: 10px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-inset);
    color: var(--color-ink-bright);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--fs-base);
    line-height: 1.5;
  }
  .inline-err {
    color: var(--color-red);
    font-size: var(--fs-meta);
  }
  .foot {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  /* Canonical .gbtn recipe (see /design-system), with a roomier tap target for the
     modal footer. */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 8px 14px;
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
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn.ghost {
    border-color: transparent;
  }
</style>
