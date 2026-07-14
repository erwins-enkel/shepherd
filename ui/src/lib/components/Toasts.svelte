<script lang="ts">
  import { toasts } from "$lib/toasts.svelte";
  import { m } from "$lib/paraglide/messages";

  // True only on the mobile list screen, where the fixed ActionBar (+ New Task)
  // shares the bottom edge with the toast banner. When set, the mobile banner is
  // inset to float just above the bar so it never covers the button (issue #810).
  let { aboveActionBar = false }: { aboveActionBar?: boolean } = $props();
</script>

{#if toasts.items.length}
  <div class="toasts" class:above-bar={aboveActionBar} aria-live="polite" aria-atomic="false">
    {#each toasts.items as t (t.id)}
      <!-- hold()/release() pause timed info auto-dismiss while hovered or focused;
           the store no-ops both for undo toasts, so attaching uniformly is safe. -->
      <div
        class="toast"
        class:is-undo={t.tone === "undo"}
        role={t.alert ? "alert" : "status"}
        style={t.durationMs !== undefined ? `--ms:${t.durationMs}ms` : undefined}
        onpointerenter={() => toasts.hold(t.id)}
        onpointerleave={() => toasts.release(t.id)}
        onfocusin={() => toasts.hold(t.id)}
        onfocusout={() => toasts.release(t.id)}
      >
        <span class="msg">{t.text}</span>
        {#if t.tone === "undo"}
          <button type="button" class="undo" onclick={() => toasts.cancel(t.id)}>
            {t.undoLabel}
            <span class="bar" aria-hidden="true"></span>
          </button>
        {:else}
          <!-- Action + ✕ are ONE flex item: as two siblings, line-breaking collects
               them separately, so a long action label orphans the ✕ onto a third
               row once button + gap + ✕ exceeds the line box. Grouping also leaves
               exactly one margin-left:auto on the row, so the free space can't be
               split equally between two auto margins (Flexbox §8.1). -->
          <div class="actions">
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
          </div>
          <!-- Stays a direct child of .toast — absolutely positioned against it. -->
          {#if t.durationMs !== undefined}
            <!-- Keyed on armSeq so a keyed refresh recreates the node, restarting
                 the drain animation in sync with the freshly re-armed timer. -->
            {#key t.armSeq}
              <span class="countdown" class:paused={t.held} aria-hidden="true"></span>
            {/key}
          {/if}
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  /* Desktop: a bottom-center floating stack, clear of the safe area. On phones
     it becomes a full-width banner flush to the bottom edge — see the mobile
     block at the foot of this file. */
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
    position: relative;
    pointer-events: auto;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    /* Split axes deliberately: `gap: 14px` is a both-axes shorthand, so wrapping
       would silently adopt 14px as the row gap too. 8px matches the stack rhythm. */
    column-gap: 14px;
    row-gap: 8px;
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
  /* Flex base = max-content, so line-breaking wraps .actions away rather than
     shrinking the message: the long-action-label squeeze (3-line column) can't
     recur. overflow-wrap catches an unbreakable branch name that alone exceeds
     the line; flex-grow right-aligns a lone ✕ when there's no action button. */
  .msg {
    flex: 1 1 auto;
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    letter-spacing: 0.02em;
  }
  /* The one auto margin on the row (see markup note). min-width:0 lets it shrink
     so .undo inside it can, which is what keeps the ✕ beside the button at
     --ui-scale 1.5 (--fs-meta 16.5px → the button alone overflows a phone banner). */
  .actions {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-left: auto;
    min-width: 0;
  }
  /* No margin-left:auto here or on .x — .actions owns the row's single auto margin,
     and .msg's flex-grow right-aligns the undo-tone button (a direct child of
     .toast, outside .actions). A second auto margin would reintroduce the §8.1
     equal-split of free space that grouping exists to prevent. */
  .undo {
    position: relative;
    flex-shrink: 1;
    min-width: 0;
    max-width: 100%;
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
  /* Depleting underline at the bottom of the UNDO button counting down the commit
     window. transform-only (no layout), and the app-wide reduced-motion guard
     zeroes it out. On phones the in-button bar is hidden in favor of a
     full-width amber drain bar along the top edge of the banner (see mobile block). */
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
  /* Neutral depleting countdown bar for timed INFO toasts, along the bottom edge.
     Distinct from the amber undo bar — amber stays reserved for the commit
     deadline. Freezes (paused) while hover/focus pauses the auto-dismiss timer,
     so it never drains to empty while the toast lingers under the pointer. */
  .countdown {
    position: absolute;
    left: 0;
    bottom: 0;
    height: 2px;
    width: 100%;
    background: var(--color-muted);
    transform-origin: left;
    animation: toast-deplete var(--ms, 4000ms) linear forwards;
  }
  .countdown.paused {
    animation-play-state: paused;
  }
  .x {
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
     edge, with a tighter type scale. The undo banner's top border is neutralized
     so the ONLY amber at the top edge is the draining bar — a full-width amber
     strip along the top of the banner that drains left→right to count down the
     commit window. Bottom edge carries the home-bar safe area, so the bar lives
     at the top. */
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
    /* The global .is-undo rule sets all four borders amber; mobile zeroes only
       left/right/bottom widths, leaving a permanent amber top border. Neutralize
       it so the neutral separator line is visible when the drain bar is gone. */
    .is-undo {
      border-top-color: var(--color-line-bright);
    }
    .msg {
      font-size: var(--fs-meta);
    }
    /* In-button underline bar is hidden on mobile — the ::after drain bar takes over. */
    .bar {
      display: none;
    }
    /* Full-width amber bar along the top edge that drains left→right, overlaying
       the neutral top border. Full = amber strip, drained = neutral line only. */
    .is-undo::after {
      content: "";
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 3px;
      background: var(--color-amber);
      transform-origin: left;
      animation: toast-deplete var(--ms, 5000ms) linear forwards;
    }
    /* Info countdown moves to the TOP edge on mobile (same rationale as the undo
       drain bar: the bottom edge carries the home-bar safe area). Stays neutral
       muted — distinct from the amber undo strip. */
    .countdown {
      top: 0;
      bottom: auto;
      height: 3px;
    }
    /* On the mobile LIST screen the fixed ActionBar (+ New Task) occupies the
       bottom edge too; at a higher z-index the toast banner would fully cover it
       (issue #810). When the action bar is present, inset the banner to float just
       above it — mirroring the shell's own padding-bottom reserve so the two can't
       drift. Compound selector (.toasts.above-bar) so it beats the base .toasts
       rule on specificity, not source order. */
    .toasts.above-bar {
      bottom: calc(
        var(--mobile-actionbar-h) + max(var(--mobile-actionbar-pad), env(safe-area-inset-bottom))
      );
    }
    /* No longer flush to the screen edge, so the home-bar safe-area reserve is the
       action bar's job — drop the first-child's extra padding to avoid doubling it. */
    .toasts.above-bar .toast:first-child {
      padding-bottom: 10px;
    }
  }
</style>
