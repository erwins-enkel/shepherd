<script lang="ts">
  import { m } from "$lib/paraglide/messages";

  let {
    tab,
    scrolledUp,
    parked,
    ended,
    endReason,
    resuming,
    resumeFailed,
    resumable,
    stranded = false,
    authUrl = null,
    scrollToTop,
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
    resumable: boolean;
    // herdr-restored husk → distinct "agent died — revive" label on the in-terminal resume banner (#1630)
    stranded?: boolean;
    /** Pending MCP OAuth authorization URL for an awaiting-input block — the operator must
     *  open it in their browser. null when the agent isn't waiting on an auth URL. */
    authUrl?: string | null;
    scrollToTop: () => void;
    scrollToBottom: () => void;
    takeover: () => void;
    reattach: () => void;
    resumeSession: () => void;
  } = $props();

  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  function openAuth() {
    if (authUrl) window.open(authUrl, "_blank", "noopener,noreferrer");
  }
  async function copyAuth() {
    if (!authUrl || !navigator.clipboard) return; // no clipboard (insecure context) → don't fake success
    try {
      await navigator.clipboard.writeText(authUrl);
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 2000);
    } catch {
      /* clipboard denied (unfocused/insecure) — the URL stays visible to copy manually */
    }
  }
</script>

{#if tab === "term" && scrolledUp && !parked}
  <div class="scroll-jump">
    <button
      class="scroll-jump-btn"
      type="button"
      onclick={scrollToTop}
      title={m.viewport_scroll_to_top()}
      aria-label={m.viewport_scroll_to_top()}
    >
      <span aria-hidden="true">↑</span>
    </button>
    <button
      class="scroll-jump-btn"
      type="button"
      onclick={scrollToBottom}
      title={m.viewport_scroll_to_bottom()}
      aria-label={m.viewport_scroll_to_bottom()}
    >
      <span aria-hidden="true">↓</span>
    </button>
  </div>
{/if}
{#if authUrl && tab === "term" && !parked}
  <!-- Non-modal top strip: an MCP OAuth prompt (e.g. Notion/Vercel) whose URL Claude
       word-wraps un-clickably in the terminal. Sourced from the JSONL, so the full URL
       is intact. The prompt sits at the terminal's bottom, so a top strip never covers
       it. Full URL shown (title=full) so the operator can vet the host before opening. -->
  <div class="auth-banner" role="status">
    <span class="auth-icon" aria-hidden="true">🔗</span>
    <div class="auth-text">
      <span class="auth-title">{m.viewport_auth_title()}</span>
      <span class="auth-url" title={authUrl}>{authUrl}</span>
    </div>
    <div class="auth-actions">
      <button class="auth-btn primary" type="button" onclick={openAuth}>
        {m.viewport_auth_open()}
      </button>
      <button class="auth-btn" type="button" onclick={copyAuth}>
        {copied ? m.viewport_auth_copied() : m.viewport_auth_copy()}
      </button>
    </div>
  </div>
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
{:else if ended && !parked && tab === "term" && resumable}
  <button class="parked resume" type="button" onclick={() => resumeSession()} disabled={resuming}>
    <span class="parked-icon" aria-hidden="true">{resuming ? "⟳" : "↻"}</span>
    <span class="parked-title"
      >{resumeFailed
        ? m.viewport_resume_failed()
        : stranded
          ? m.stranded_revive_title()
          : m.viewport_resume_title()}</span
    >
    <span class="parked-sub">{resuming ? m.common_loading() : m.viewport_resume_sub()}</span>
  </button>
{/if}

<style>
  /* auth-banner: non-modal top strip surfacing a pending MCP OAuth URL. Anchored at the
     top so it never covers the prompt/input at the terminal's bottom. Amber accent — an
     actionable "needs you" state, not a success. The session stalls silently until the
     operator acts, so the strip is deliberately loud: amber-washed surface, slide-down
     entry, and a continuous "breathing" halo (below) for as long as the URL is pending. */
  .auth-banner {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    /* Nested mix: the inner mix tints the head tone amber; the outer mix restores the
       strip's 96% translucency so the backdrop blur keeps reading through (a single
       amber/head mix would silently produce an opaque surface). */
    background: color-mix(
      in srgb,
      color-mix(in srgb, var(--color-amber) 14%, var(--color-head)) 96%,
      transparent
    );
    backdrop-filter: blur(2px);
    border-bottom: 1px solid color-mix(in srgb, var(--color-amber) 80%, var(--color-line-bright));
    box-shadow: 0 3px 12px rgba(0, 0, 0, 0.35);
    animation: auth-banner-in 0.14s ease;
  }
  /* Continuous amber halo, pulsed by animating this pseudo's OPACITY only — an infinite
     box-shadow animation would repaint the full-width strip every frame. Downward-only
     geometry: .vp-body clips at overflow:hidden and the banner sits flush with its
     top/left/right edges, so a symmetric halo would clip on three sides. An outer
     box-shadow renders outside the border-box only, so nothing inside the strip is
     tinted; z-index -1 keeps it under the text/buttons within the banner's own
     stacking context (z-index 3 above). */
  .auth-banner::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: -1;
    box-shadow: 0 4px 18px color-mix(in srgb, var(--color-amber) 55%, transparent);
    animation: auth-banner-glow 2s ease-in-out infinite alternate;
  }
  @keyframes auth-banner-in {
    from {
      opacity: 0;
      transform: translateY(-6px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  @keyframes auth-banner-glow {
    from {
      opacity: 0.35;
    }
    to {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .auth-banner {
      animation: none;
    }
    .auth-banner::after {
      /* No motion — the halo rests at a steady mid opacity so the banner still reads
         clearly louder than the terminal behind it. */
      animation: none;
      opacity: 0.6;
    }
  }
  .auth-icon {
    color: var(--color-amber);
    font-size: var(--fs-xl);
    line-height: 1;
    flex: none;
  }
  .auth-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0; /* let the URL truncate instead of overflowing the row */
    flex: 1 1 auto;
  }
  .auth-title {
    color: var(--color-ink-bright);
    font-size: var(--fs-lg); /* ≥16px body-text floor */
    line-height: 1.2;
  }
  .auth-url {
    /* --color-ink, not muted: muted lands marginally under the 4.5:1 AA floor on the
       amber-washed surface (≈4.4:1 in dark and light themes). */
    color: var(--color-ink);
    font-size: var(--fs-base);
    font-family: var(--font-mono, monospace);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .auth-actions {
    display: flex;
    gap: 6px;
    flex: none;
  }
  .auth-btn {
    min-height: 32px;
    padding: 0 12px;
    border-radius: 6px;
    border: 1px solid var(--color-line-bright);
    background: var(--color-bg);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    cursor: pointer;
    transition:
      background 0.12s ease,
      border-color 0.12s ease;
  }
  .auth-btn:hover {
    background: var(--color-hover);
  }
  .auth-btn.primary {
    border-color: color-mix(in srgb, var(--color-amber) 70%, var(--color-line-bright));
    background: color-mix(in srgb, var(--color-amber) 18%, var(--color-bg));
    color: var(--color-ink-bright);
  }
  .auth-btn.primary:hover {
    background: color-mix(in srgb, var(--color-amber) 28%, var(--color-bg));
  }
  /* Coarse pointers (touch): 44px tap-target floor. */
  @media (pointer: coarse) {
    .auth-btn {
      min-height: 44px;
      padding: 0 16px;
    }
  }

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

  /* jump controls: small round affordances, bottom-right of the terminal body.
     sit above xterm content (z-index 2) but below the parked/resume overlays (3) */
  .scroll-jump {
    position: absolute;
    /* Lift clear of the ReviewInFlightBanner's bottom strip when it's shown:
       --review-banner-h (published on .vp-body) is that banner's occupied height,
       0 when hidden — so this reduces to the resting 12px with no banner. */
    bottom: calc(12px + var(--review-banner-h, 0px));
    right: 14px;
    z-index: 2;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--mobile-shell-pad);
  }
  .scroll-jump-btn {
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
       and the buttons rest on the steady halo set above. */
    animation:
      scroll-bottom-in 0.14s ease,
      scroll-bottom-glow 1.5s ease-in-out 0.14s 2;
  }
  .scroll-jump-btn:hover {
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
    .scroll-jump-btn {
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
