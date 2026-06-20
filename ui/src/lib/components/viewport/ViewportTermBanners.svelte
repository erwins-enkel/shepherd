<script lang="ts">
  import type { Session } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  let {
    tab,
    scrolledUp,
    parked,
    ended,
    endReason,
    resuming,
    resumeFailed,
    session,
    scrollToBottom,
    takeover,
    reattach,
    resumeSession,
  }: {
    tab: string;
    scrolledUp: boolean;
    parked: boolean;
    ended: boolean;
    endReason: "gone" | "unreachable";
    resuming: boolean;
    resumeFailed: boolean;
    session: Session;
    scrollToBottom: () => void;
    takeover: () => void;
    reattach: () => void;
    resumeSession: () => void;
  } = $props();
</script>

{#if tab === "term" && scrolledUp && !parked}
  <button
    class="scroll-bottom"
    type="button"
    onclick={scrollToBottom}
    title={m.viewport_scroll_to_bottom()}
    aria-label={m.viewport_scroll_to_bottom()}
  >
    <span aria-hidden="true">↓</span>
  </button>
{/if}
{#if parked && tab === "term"}
  <button class="parked" type="button" onclick={takeover}>
    <span class="parked-icon" aria-hidden="true">▶</span>
    <span class="parked-title">{m.viewport_parked_title()}</span>
    <span class="parked-sub">{m.viewport_parked_sub()}</span>
  </button>
{/if}
{#if ended && !parked && tab === "term" && endReason === "unreachable"}
  <!-- herdr is down, not the agent — re-attach (no claudeSessionId needed) -->
  <button class="parked resume" type="button" onclick={reattach}>
    <span class="parked-icon" aria-hidden="true">↻</span>
    <span class="parked-title">{m.viewport_reconnect_title()}</span>
    <span class="parked-sub">{m.viewport_reconnect_sub()}</span>
  </button>
{:else if ended && !parked && tab === "term" && session.claudeSessionId}
  <button class="parked resume" type="button" onclick={() => resumeSession()} disabled={resuming}>
    <span class="parked-icon" aria-hidden="true">{resuming ? "⟳" : "↻"}</span>
    <span class="parked-title"
      >{resumeFailed ? m.viewport_resume_failed() : m.viewport_resume_title()}</span
    >
    <span class="parked-sub">{resuming ? m.common_loading() : m.viewport_resume_sub()}</span>
  </button>
{/if}

<style>
  /* parked: this terminal is live on another device — tap to take it back */
  .parked {
    position: absolute;
    inset: 0;
    z-index: 3;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    background: color-mix(in srgb, var(--color-bg) 78%, transparent);
    backdrop-filter: blur(1.5px);
    border: 0;
    cursor: pointer;
    font: inherit;
    color: var(--color-ink);
  }
  .parked-icon {
    color: var(--color-amber);
    font-size: var(--fs-2xl);
    line-height: 1;
  }
  .parked-title {
    color: var(--color-ink-bright);
    letter-spacing: 0.08em;
    font-size: var(--fs-base);
  }
  .parked-sub {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .parked.resume:disabled {
    cursor: progress;
    opacity: 0.7;
  }

  /* jump-to-bottom: small round affordance, bottom-right of the terminal body.
     sits above xterm content (z-index 2) but below the parked/resume overlays (3) */
  .scroll-bottom {
    position: absolute;
    bottom: 12px;
    right: 14px;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 38px;
    height: 38px;
    border-radius: 50%;
    border: 1px solid color-mix(in srgb, var(--color-amber) 60%, var(--color-line-bright));
    background: color-mix(in srgb, var(--color-head) 96%, transparent);
    backdrop-filter: blur(2px);
    color: var(--color-amber);
    font-size: var(--fs-xl);
    line-height: 1;
    cursor: pointer;
    /* depth shadow + a soft amber halo so the affordance catches the eye the
       moment it appears — our accent signals "there's newer output below". */
    box-shadow:
      0 3px 12px rgba(0, 0, 0, 0.45),
      0 0 12px color-mix(in srgb, var(--color-amber) 30%, transparent);
    transition:
      background 0.12s ease,
      color 0.12s ease,
      box-shadow 0.12s ease,
      transform 0.12s ease;
    /* slide in, then pulse the amber glow twice to draw the eye; the pulse ends
       and the button rests on the steady halo set above. */
    animation:
      scroll-bottom-in 0.14s ease,
      scroll-bottom-glow 1.5s ease-in-out 0.14s 2;
  }
  .scroll-bottom:hover {
    background: var(--color-hover);
    color: var(--color-amber);
    transform: translateY(-1px);
    /* end the entry/glow pulse so this box-shadow isn't suppressed by the
       still-running animation (the pulse is a one-shot attention cue anyway). */
    animation: none;
    box-shadow:
      0 3px 12px rgba(0, 0, 0, 0.45),
      0 0 16px color-mix(in srgb, var(--color-amber) 45%, transparent);
  }
  /* Coarse pointers (touch): grow the free-floating affordance to a ≥44px tap
     target. It sits in the terminal corner with room to spare, so enlarging the
     element itself is simplest — stays round, stays flat. Desktop (fine pointer)
     keeps the 38px glyph. */
  @media (pointer: coarse) {
    .scroll-bottom {
      min-width: 44px;
      min-height: 44px;
    }
  }
  @keyframes scroll-bottom-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  @keyframes scroll-bottom-glow {
    0%,
    100% {
      box-shadow:
        0 3px 12px rgba(0, 0, 0, 0.45),
        0 0 12px color-mix(in srgb, var(--color-amber) 30%, transparent);
    }
    50% {
      box-shadow:
        0 3px 12px rgba(0, 0, 0, 0.45),
        0 0 22px color-mix(in srgb, var(--color-amber) 65%, transparent);
    }
  }
</style>
