<script lang="ts">
  import { toasts } from "$lib/toasts.svelte";
  import { m } from "$lib/paraglide/messages";
</script>

{#if toasts.items.length}
  <div class="toasts" aria-live="polite" aria-atomic="false">
    {#each toasts.items as t (t.id)}
      <div class="toast" class:is-undo={t.tone === "undo"} role="status">
        <span class="msg">{t.text}</span>
        {#if t.tone === "undo"}
          <button type="button" class="undo" onclick={() => toasts.cancel(t.id)}>
            {t.undoLabel}
            <span class="bar" style="--ms:{t.durationMs}ms" aria-hidden="true"></span>
          </button>
        {:else}
          <button
            type="button"
            class="x"
            onclick={() => toasts.close(t.id)}
            aria-label={m.common_close()}
          >
            ✕
          </button>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  /* Bottom-center stack, clear of the safe area and the touch control bar. */
  .toasts {
    position: fixed;
    left: 50%;
    bottom: calc(16px + env(safe-area-inset-bottom));
    transform: translateX(-50%);
    z-index: 60;
    display: flex;
    flex-direction: column-reverse;
    gap: 8px;
    align-items: center;
    pointer-events: none;
  }
  /* A summoned overlay, so the lift shadow is earned (DESIGN.md: flat at rest). */
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 14px;
    max-width: min(440px, 92vw);
    padding: 10px 12px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5);
    animation: toast-rise 0.18s ease-out;
  }
  .is-undo {
    border-color: var(--color-amber);
  }
  .msg {
    color: var(--color-ink-bright);
    font-size: 12.5px;
    letter-spacing: 0.02em;
  }
  .undo {
    position: relative;
    margin-left: auto;
    flex-shrink: 0;
    background: transparent;
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    color: var(--color-amber);
    font: inherit;
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 5px 10px;
    cursor: pointer;
    overflow: hidden;
  }
  .undo:hover {
    background: var(--color-hover);
  }
  /* Depleting underline counting down the commit window. transform-only (no
     layout), and the app-wide reduced-motion guard zeroes it out. */
  .bar {
    position: absolute;
    left: 0;
    bottom: 0;
    height: 2px;
    width: 100%;
    background: var(--color-amber);
    transform-origin: left;
    animation: toast-deplete var(--ms, 5000ms) linear forwards;
  }
  .x {
    margin-left: auto;
    flex-shrink: 0;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    padding: 2px 4px;
  }
  .x:hover {
    color: var(--color-ink);
  }
  @keyframes toast-rise {
    from {
      transform: translateY(8px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
  @keyframes toast-deplete {
    from {
      transform: scaleX(1);
    }
    to {
      transform: scaleX(0);
    }
  }
</style>
