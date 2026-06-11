<script lang="ts">
  import { toasts } from "$lib/toasts.svelte";
  import { m } from "$lib/paraglide/messages";
</script>

{#if toasts.items.length}
  <div class="toasts" aria-live="polite" aria-atomic="false">
    {#each toasts.items as t (t.id)}
      <!-- hold()/release() pause timed info auto-dismiss while hovered or focused;
           the store no-ops both for undo toasts, so attaching uniformly is safe. -->
      <div
        class="toast"
        class:is-undo={t.tone === "undo"}
        role={t.alert ? "alert" : "status"}
        onpointerenter={() => toasts.hold(t.id)}
        onpointerleave={() => toasts.release(t.id)}
        onfocusin={() => toasts.hold(t.id)}
        onfocusout={() => toasts.release(t.id)}
      >
        <span class="msg">{t.text}</span>
        {#if t.tone === "undo"}
          <button type="button" class="undo" onclick={() => toasts.cancel(t.id)}>
            <span class="undo-label">{t.undoLabel}</span>
            <span class="bar" style="--ms:{t.durationMs}ms" aria-hidden="true"></span>
          </button>
        {:else}
          {#if t.actionLabel}
            <button type="button" class="undo" onclick={() => toasts.act(t.id)}>
              {t.actionLabel}
            </button>
          {/if}
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
    font-size: var(--fs-base);
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
    font-size: var(--fs-meta);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 5px 10px;
    cursor: pointer;
    overflow: hidden;
  }
  .undo:hover {
    background: var(--color-hover);
  }
  .undo-label {
    position: relative;
    z-index: 1;
  }
  /* Depleting underline counting down the commit window. transform-only (no
     layout), and the app-wide reduced-motion guard zeroes it out. On phones it
     grows into a full-height fill behind the label (see the mobile block). */
  .bar {
    position: absolute;
    left: 0;
    bottom: 0;
    height: 2px;
    width: 100%;
    background: var(--color-amber);
    transform-origin: left;
    animation: toast-deplete var(--ms, 5000ms) linear forwards;
    z-index: 0;
  }
  .x {
    margin-left: auto;
    flex-shrink: 0;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-base);
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

  /* On small phones the stack becomes a full-width banner flush to the bottom
     edge, with a tighter type scale. The undo countdown grows from a hairline
     underline into a translucent fill that drains across the whole button —
     the receding amber wash reads the shrinking commit window at a glance. */
  @media (max-width: 768px) {
    .toasts {
      left: 0;
      right: 0;
      bottom: 0;
      transform: none;
      gap: 0;
      align-items: stretch;
    }
    .toast {
      max-width: none;
      width: 100%;
      border-radius: 0;
      border-left: 0;
      border-right: 0;
      border-bottom: 0;
      padding: 10px 14px;
    }
    /* column-reverse puts the first DOM child at the bottom — only that banner
       touches the screen edge, so only it reserves the home-bar safe area. */
    .toast:first-child {
      padding-bottom: calc(10px + env(safe-area-inset-bottom));
    }
    .msg {
      font-size: var(--fs-meta);
    }
    .bar {
      top: 0;
      bottom: auto;
      height: 100%;
      background: color-mix(in srgb, var(--color-amber) 22%, transparent);
    }
  }
</style>
