<script lang="ts">
  import { m } from "$lib/paraglide/messages";

  // Reliability floor for OSC 52 clipboard writes (see Viewport.svelte). The write
  // arrives async over the WS — not inside the `c` keydown that triggered it — so
  // browsers may refuse navigator.clipboard.writeText outside a real user gesture.
  // This pill re-offers the copy as an explicit click, which IS a gesture.
  let {
    text,
    oncopied,
    oncopyfailed,
    ondismiss,
  }: {
    text: string;
    oncopied: () => void;
    oncopyfailed?: (text: string) => void;
    ondismiss: () => void;
  } = $props();

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      oncopied();
    } catch {
      oncopyfailed?.(text);
    }
  }

  // Auto-dismiss so a stale pill doesn't linger once the moment has passed.
  // Reads `text` so a second OSC 52 write that replaces it on an already-mounted
  // pill re-arms the countdown (each copy gets the full 20s, not the leftover).
  $effect(() => {
    void text;
    const t = setTimeout(() => ondismiss(), 20_000);
    return () => clearTimeout(t);
  });
</script>

<div class="clip-pill">
  <span class="clip-prompt" role="status" aria-live="polite">{m.clipboard_pill_prompt()}</span>
  <button type="button" class="gbtn primary" onclick={copy}>{m.clipboard_pill_copy()}</button>
  <button
    type="button"
    class="clip-dismiss"
    aria-label={m.common_close()}
    onclick={() => ondismiss()}
  >
    <span aria-hidden="true">×</span>
  </button>
</div>

<style>
  /* Small, non-blocking anchored affordance — no scrim, mirrors the scroll-jump /
     review-banner strip's positioning within .vp-body (position: relative). */
  .clip-pill {
    position: absolute;
    bottom: calc(12px + var(--review-banner-h, 0px));
    left: 50%;
    transform: translateX(-50%);
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px 6px 12px;
    background: var(--color-head);
    border: 1px solid var(--color-line);
    border-radius: 4px;
    box-shadow: 0 2px 8px color-mix(in srgb, var(--color-bg) 40%, transparent);
    white-space: nowrap;
  }
  .clip-prompt {
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.04em;
  }
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .clip-dismiss {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    background: transparent;
    border: 0;
    color: var(--color-faint);
    font-size: var(--fs-base);
    line-height: 1;
    cursor: pointer;
  }
  .clip-dismiss:hover {
    color: var(--color-ink-bright);
  }
  .clip-dismiss:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
</style>
