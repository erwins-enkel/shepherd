<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { actStarPrompt } from "$lib/api";
  import { toasts } from "$lib/toasts.svelte";
  import type { StarPromptStatus } from "$lib/types";

  // A gentle, non-blocking nudge: it floats bottom-left, doesn't seize the app,
  // and carries no scrim (per the design-system rule for non-modal popovers).
  // Three exits: star with the operator's gh account, snooze 3 days, or dismiss.
  // The resolved status bubbles up via `onresolve` so the page owns store state.
  //
  // The card closes the instant the nudge resolves (on every connected client,
  // via the store's star-prompt:status push). The thank-you is therefore a toast,
  // not an in-card phase — it survives the card unmounting and only the operator
  // who actually starred sees it.

  let { onresolve }: { onresolve: (status: StarPromptStatus) => void } = $props();

  let busy = $state(false);
  let errored = $state(false);

  async function run(action: "dismiss" | "snooze" | "star") {
    if (busy) return;
    busy = true;
    errored = false;
    try {
      const next = await actStarPrompt(action);
      if (action === "star") toasts.info(m.star_prompt_thanks(), { key: "star-prompt-thanks" });
      onresolve(next);
    } catch {
      errored = true;
    } finally {
      busy = false;
    }
  }
</script>

<div class="star-prompt" role="dialog" aria-label={m.star_prompt_title()}>
  <p class="sp-title">{m.star_prompt_title()}</p>
  <p class="sp-body">{m.star_prompt_body()}</p>
  {#if errored}
    <p class="sp-error">{m.star_prompt_error()}</p>
  {/if}
  <div class="sp-actions">
    <button class="sp-btn" disabled={busy} onclick={() => run("dismiss")}>
      {m.star_prompt_dismiss()}
    </button>
    <button class="sp-btn" disabled={busy} onclick={() => run("snooze")}>
      {m.star_prompt_snooze()}
    </button>
    <button class="sp-btn primary" disabled={busy} onclick={() => run("star")}>
      <span class="sp-star" aria-hidden="true">★</span>
      {m.star_prompt_star()}
    </button>
  </div>
</div>

<style>
  .star-prompt {
    position: fixed;
    left: 16px;
    bottom: 16px;
    z-index: 55;

    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    width: min(320px, calc(100vw - 32px));

    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5);
  }

  .sp-title {
    margin: 0;
    font-size: var(--fs-meta);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-ink-bright);
  }

  .sp-body {
    margin: 0;
    font-size: var(--fs-base);
    line-height: 1.5;
    color: var(--color-muted);
  }

  .sp-error {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-red);
  }

  .sp-star {
    color: var(--color-amber);
  }

  .sp-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 2px;
  }

  /* Mirrors the canonical .gbtn recipe (see /design-system). */
  .sp-btn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 3px 9px;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s;
  }

  .sp-btn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  .sp-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .sp-btn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  @keyframes star-prompt-in {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .star-prompt {
    animation: star-prompt-in 160ms ease-out;
  }
</style>
