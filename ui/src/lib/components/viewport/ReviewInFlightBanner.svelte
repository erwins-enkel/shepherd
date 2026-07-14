<script lang="ts">
  import type { Session, SessionActivity, SessionStatus } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { reviews, planGates, repoConfig, MAX_ACTIVITY_LINES } from "$lib/reviews.svelte";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import {
    activeReworkBannerState,
    reviewBannerState,
    criticConclusionShows,
    type BannerState,
    type ReviewKind,
  } from "$lib/review-banner";
  import { planStallStatus } from "$lib/plan-status";
  import { addressStallStatus } from "$lib/review-status";
  import { clock } from "$lib/now.svelte";
  import { environmentLabel } from "$lib/reviewer-env";

  // Non-blocking signal that an in-flight PR-critic / plan-gate review may steer
  // this session when it concludes (issue #1022). Shown only when a paste could
  // actually land per current toggles; escalates if the operator types mid-review;
  // flips to a brief auto-dismissing conclusion tier. The future stage-and-apply
  // guard is out of scope — this is the signal only.
  let {
    session,
    dStatus,
    activity,
    keystrokes,
    tab,
    height = $bindable(0),
    active = $bindable(false),
    inflight = $bindable(false),
  }: {
    session: Session;
    dStatus: SessionStatus;
    activity?: SessionActivity;
    keystrokes: number;
    tab: string;
    height?: number;
    /** Logical "this banner occupies the strip" signal (mirrors the render
     *  condition below). Bound out so a sibling status banner (CiRunningBanner)
     *  can suppress itself synchronously — no offsetHeight/paint race. */
    active?: boolean;
    /** True iff the banner is showing its in-flight tier (a review runs off-screen,
     *  the session PTY is idle). Bound out so the Viewport can dim the terminal only
     *  in that phase — not during addressing (agent works in the PTY) or conclusion. */
    inflight?: boolean;
  } = $props();

  // Live in-flight flags (mutually exclusive: plan-gate = planning phase, critic =
  // post-PR, so never both at once).
  const criticReviewing = $derived(reviews.isReviewing(session.id));
  const planReviewing = $derived(planGates.isReviewing(session.id));
  const liveKind = $derived<ReviewKind | null>(
    criticReviewing ? "critic" : planReviewing ? "plangate" : null,
  );

  // Live rolling activity feed of whichever reviewer is in flight (oldest→newest, ≤
  // MAX_ACTIVITY_LINES). Rendered as the tail preview under the in-flight headline: the reviewer
  // runs off-screen in its own worktree, so this is the operator's only window into what it's
  // doing. Verbatim tool-use lines (e.g. "$ git diff", "read poller.ts") — NOT translated.
  const feed = $derived<string[]>(
    liveKind === "critic"
      ? reviews.activityFeed(session.id)
      : liveKind === "plangate"
        ? planGates.activityFeed(session.id)
        : [],
  );

  // The reviewer is a separate job from the task session shown above the terminal. Read the
  // environment captured for whichever review kind is live so the banner identifies that job,
  // not the task agent. A legacy run with no resolved provider stays visually unchanged.
  const reviewerEnv = $derived(
    liveKind === "critic"
      ? reviews.reviewerEnvFor(session.id)
      : liveKind === "plangate"
        ? planGates.reviewerEnvFor(session.id)
        : null,
  );
  const reviewerIdentity = $derived(
    reviewerEnv?.provider
      ? environmentLabel(reviewerEnv.provider, reviewerEnv.model, reviewerEnv.effort)
      : null,
  );

  // Session's effective autopilot (mirrors src/effective-autopilot.ts): per-session
  // override wins, else the repo default. `auto` (drain) also auto-releases plans.
  const autoReleased = $derived(
    session.auto || (session.autopilotEnabled ?? repoConfig.autopilot[session.repoPath] ?? false),
  );

  // Sticky escalation + the brief conclusion tier are the only reactive bits the
  // display reads; the snapshots and transition bookkeeping are plain locals so
  // they neither leak as effect deps nor force re-runs.
  let escalated = $state(false);
  let conclusion = $state<BannerState | null>(null);

  let prevInFlight = false;
  let snapshotRound = 0;
  let snapshotKeystrokes = 0;
  let entryKind: ReviewKind = "critic";
  let conclusionTimer: ReturnType<typeof setTimeout> | undefined;

  function resolveConclusion(kind: ReviewKind) {
    const isPlan = kind === "plangate";
    const verdict = isPlan ? planGates.map[session.id] : reviews.map[session.id];
    if (!verdict) {
      conclusion = null; // nothing landed → nothing to confirm
      return;
    }
    const newRound = isPlan
      ? (verdict as { round: number }).round
      : (verdict as { addressRound: number }).addressRound;
    const delivered = newRound > snapshotRound;
    // Critic conclusion is gated on the SAME predicate as the in-flight tier: if
    // auto-address is off (or the streak is stalled at the cap) the banner never
    // warned in-flight, so it must not flash a conclusion either — unless a steer
    // actually landed (delivered), which is always worth confirming. Plan-gate
    // always shows, so no gate there. (issue #1022)
    if (
      !isPlan &&
      !criticConclusionShows(
        repoConfig.autoAddress[session.repoPath] ?? false,
        verdict as { addressRound: number; addressCap: number },
        delivered,
      )
    ) {
      conclusion = null;
      return;
    }
    conclusion = reviewBannerState({
      kind,
      phase: "conclusion",
      escalated: false,
      autoAddressOn: repoConfig.autoAddress[session.repoPath] ?? false,
      verdict: isPlan ? undefined : reviews.map[session.id],
      decision: verdict.decision,
      delivered,
      autoReleased,
    });
    clearTimeout(conclusionTimer);
    conclusionTimer = setTimeout(() => (conclusion = null), 4000);
  }

  // Transition tracker: treats the FIRST observation of in-flight as an entry
  // (prevInFlight starts false), so a mount mid-review (page reload / terminal
  // opened while a review runs) snapshots the prior round correctly instead of
  // later reporting a false "nothing pasted". Also drives sticky escalation.
  $effect(() => {
    const nowInFlight = criticReviewing || planReviewing;
    if (nowInFlight && !prevInFlight) {
      entryKind = criticReviewing ? "critic" : "plangate";
      snapshotRound =
        entryKind === "critic"
          ? (reviews.map[session.id]?.addressRound ?? 0)
          : (planGates.map[session.id]?.round ?? 0);
      snapshotKeystrokes = keystrokes;
      escalated = false;
      clearTimeout(conclusionTimer);
      conclusion = null;
    } else if (!nowInFlight && prevInFlight) {
      resolveConclusion(entryKind);
    }
    prevInFlight = nowInFlight;
    // sticky escalation: any keystroke after the entry snapshot, while in-flight
    if (nowInFlight && keystrokes > snapshotKeystrokes) escalated = true;
  });

  $effect(() => () => clearTimeout(conclusionTimer));

  // The conclusion tier (if active) wins; otherwise the live in-flight predicate.
  const liveReviewView = $derived<BannerState>(
    reviewBannerState({
      kind: liveKind,
      phase: "in-flight",
      escalated,
      autoAddressOn: repoConfig.autoAddress[session.repoPath] ?? false,
      verdict: reviews.map[session.id],
      decision: undefined,
      delivered: false,
      autoReleased,
    }),
  );

  const activeReworkView = $derived<BannerState>(
    activeReworkBannerState({
      planPhase: session.planPhase,
      dStatus,
      planGate: planGates.map[session.id],
      planReviewing,
      // A stalled/timed-out loop is no longer active rework (the genuine in-flight "final" round
      // is not "stalled"); clock.current ticks so it flips when the timeout elapses.
      planStalled: planGates.map[session.id]
        ? planStallStatus(planGates.map[session.id]!, clock.current) === "stalled"
        : false,
      review: reviews.map[session.id],
      criticReviewing,
      criticStalled: reviews.map[session.id]
        ? addressStallStatus(reviews.map[session.id]!, clock.current) === "stalled"
        : false,
      activitySummary: activity?.summary,
    }),
  );

  const view = $derived<BannerState>(
    conclusion ?? (liveReviewView.show ? liveReviewView : activeReworkView),
  );

  function bannerText(s: BannerState): string {
    if (!s.show) return "";
    if (s.phase === "addressing") {
      const work =
        s.summary ??
        (s.fallbackKey === "reviewbanner_rework_plan_fallback"
          ? m.reviewbanner_rework_plan_fallback()
          : m.reviewbanner_rework_critic_fallback());
      return s.round != null && s.cap != null
        ? m.reviewbanner_rework_count({ round: s.round, cap: s.cap, work })
        : m.reviewbanner_rework_bare({ work });
    }
    switch (s.copyKey) {
      case "reviewbanner_calm":
        return m.reviewbanner_calm();
      case "reviewbanner_escalated":
        return m.reviewbanner_escalated();
      case "reviewbanner_pasted":
        return m.reviewbanner_pasted();
      case "reviewbanner_nothing":
        return m.reviewbanner_nothing();
      case "reviewbanner_released":
        return m.reviewbanner_released();
      case "reviewbanner_awaiting_go":
        return m.reviewbanner_awaiting_go();
      case "reviewbanner_errored":
        return m.reviewbanner_errored();
    }
  }

  // ✓ for a clean/delivered conclusion; ⚠ for the in-flight warning and errors.
  const icon = $derived(
    view.show && view.phase === "conclusion" && view.tone !== "errored" ? "✓" : "⚠",
  );

  // While a review is running or the task agent is actively addressing REWORK,
  // lead with a rotating gear ("work is happening") instead of the static ⚠. The
  // brief conclusion tiers keep the static icon above — nothing is running there.
  const spinning = $derived(
    view.show && (view.phase === "in-flight" || view.phase === "addressing"),
  );

  // Publish the banner's occupied height so the floating jump-to-latest button can
  // lift clear of it (issue: scroll button obscured by this banner). The bound
  // element mirrors the {#if} below. offsetHeight (via bind: on the element) is the
  // true occupied height incl. the 1px border-top. We ALSO seed it synchronously
  // here: this effect runs after DOM insertion but before paint, so the shared CSS
  // var is already correct on the button's first painted frame — no one-frame flash
  // under the banner, no spurious mount-time slide. bind:offsetHeight then keeps it
  // current across reflows (e.g. an orientation change re-wrapping the text).
  let bannerEl = $state<HTMLDivElement>();
  $effect(() => {
    const shown = view.show && tab === "term";
    if (active !== shown) active = shown; // logical occupancy signal for a sibling status banner (pre-paint)
    // Terminal-dim signal: only the in-flight tier (review runs off-screen, PTY idle). Narrowed
    // off `view` directly so TS sees the discriminant; NOT during addressing/conclusion.
    const preview = view.show && view.phase === "in-flight" && tab === "term";
    if (inflight !== preview) inflight = preview;
    if (!shown) {
      height = 0; // hidden branch: reset (the only place height is zeroed)
      return;
    }
    if (bannerEl) height = bannerEl.offsetHeight; // shown: seed pre-paint; never writes 0
  });
</script>

{#if view.show && tab === "term"}
  <div
    class="review-banner"
    data-tone={view.tone}
    data-phase={view.phase}
    role="status"
    aria-live="polite"
    bind:this={bannerEl}
    bind:offsetHeight={height}
    use:coachTarget={"review-inflight"}
  >
    <div class="rb-head">
      {#if spinning}
        <!-- Rotating cog: an inline SVG (not the ⚙ glyph, which renders as a color
             emoji ignoring currentColor and rotates off-center) so it tints to the
             tone accent and turns cleanly about its center. -->
        <svg
          class="rb-cog"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3" />
          <path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
          />
        </svg>
      {:else}
        <span class="rb-icon" aria-hidden="true">{icon}</span>
      {/if}
      <span class="rb-copy">
        <span class="rb-text">{bannerText(view)}</span>
        {#if view.phase === "in-flight" && reviewerIdentity}
          <span class="rb-env">{reviewerIdentity}</span>
        {/if}
      </span>
    </div>
    {#if view.show && view.phase === "in-flight"}
      <!-- Live "tail -f" of the off-screen reviewer's actions. Reserves MAX_ACTIVITY_LINES rows
           (a fixed flex-basis) so the banner keeps a stable height across the whole in-flight phase
           as lines fill progressively → one xterm refit on enter/exit, not one per line; it only
           gives way when the banner's height cap bites in a short pane. aria-hidden: the polite
           headline is the announcement; a fast-updating feed would spam a screen reader. -->
      <div class="rb-preview" style:--rb-pv-rows={MAX_ACTIVITY_LINES} aria-hidden="true">
        {#if feed.length === 0}
          <span class="rb-pv-wait">{m.reviewbanner_preview_waiting()}</span>
        {:else}
          {#each feed as line, i (i)}
            <span class="rb-pv-line">{line}</span>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Bottom strip pinned to the terminal body, directly above the steer bar. The
     terminal reserves this height — .term-mount shrinks by --review-banner-h — so the
     strip sits BELOW the live prompt, not over it; the operator can still see and use
     the prompt while a review runs. Appearing/resizing it therefore intentionally
     triggers an xterm refit. Non-blocking: no scrim/blur — it does not seize
     interaction.

     Height is CAPPED (max-height below) so it can never bury the prompt:
     - min(50%, …): never eats more than half the terminal body.
     - calc(100% - 4rem): the reflow guarantee. Banner ≤ 100% - 4rem ⇒
       .term-mount (= 100% - --review-banner-h) stays ≥ its own 4rem floor, so the floor
       can never override the reserve and force an overlap. The live preview shrinks to fit
       (flex-shrink below); the banner bottoms out at its headline row (.rb-head is
       flex-shrink:0), so the guarantee holds for any usably-sized terminal. Only at the
       .vp-body 4rem floor (expanded-recap takeover), where nothing fits both a prompt and a
       banner, does a residual overlap of at most that one headline row remain.
     - box-sizing:border-box so the padding + 1px border fold INTO the cap (else the
       rendered box overshoots it and re-opens the overlap).
     - overflow:hidden so offsetHeight (→ --review-banner-h) equals the rendered box; any
       oversized content is clipped inside the cap instead of spilling below un-measured. */
  .review-banner {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 2;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    max-height: min(50%, calc(100% - 4rem));
    overflow: hidden;
    padding: 5px 10px;
    font-size: var(--fs-meta);
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, var(--color-head));
    border-top: 1px solid color-mix(in srgb, var(--accent) 55%, var(--color-line));
    animation: rb-in 0.14s ease;
  }
  /* Prominence bump scoped to the in-flight tier only: the "review is running"
     message reads taller + larger, while the short-lived conclusion tiers keep
     the compact base size above. */
  .review-banner[data-phase="in-flight"],
  .review-banner[data-phase="addressing"] {
    padding: 9px 12px;
    font-size: var(--fs-base);
  }
  /* Headline row (icon + message) — the former single-row flex layout. flex-shrink:0
     keeps it over a shrinking preview when the banner is capped; min-width:0 lets its
     .rb-text child actually ellipsize rather than force the head past the cap. */
  .rb-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    min-width: 0;
  }
  .rb-copy {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .rb-env {
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    line-height: 1.3;
    overflow-wrap: anywhere;
  }
  /* Live activity tail under the in-flight headline. Newest line pins to the bottom
     (justify-content:flex-end); the reserved height is MAX_ACTIVITY_LINES rows (--rb-pv-rows) so
     the banner keeps a STABLE height across the whole in-flight phase as lines fill in — one
     xterm refit on enter/exit, not one per line. Monospace + quiet ink so it reads as terminal
     echo of the off-screen reviewer, not app chrome. */
  .rb-preview {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    margin-top: 6px;
    /* Reserve --rb-pv-rows rows as a fixed flex-basis (stable height → one xterm refit),
       but flex-shrink:1 + min-height:0 let it give way FIRST when the banner's max-height
       cap bites in a short pane; flex-end + overflow:hidden then keep the newest line
       pinned at the bottom and clip the oldest off the top. */
    flex: 0 1 calc(var(--fs-meta) * 1.5 * var(--rb-pv-rows, 2));
    min-height: 0;
    overflow: hidden;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  .rb-pv-line {
    line-height: 1.5;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Older lines recede so the newest (bottom) reads as "happening now". */
  .rb-pv-line:not(:last-child) {
    color: var(--color-faint);
  }
  .rb-pv-wait {
    line-height: 1.5;
    color: var(--color-faint);
    font-style: italic;
  }
  .rb-icon {
    font-size: var(--fs-base);
    line-height: 1;
  }
  /* Rotating gear — the "Shepherd is working" cue. Tinted to the tone accent
     (amber calm / warn escalated), echoing the amber REVIEWING pulse. Rotation
     reuses the shared icon-btn-spin keyframe (app.css), NOT the .spin class,
     whose reduced-motion rule (animation:none) would drop this state signal. */
  .rb-cog {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    color: var(--accent);
    animation: icon-btn-spin 2.4s linear infinite;
  }
  /* Functional indicator: under reduced-motion keep the rotation (it's what
     reads as "still working" here) but slow it way down instead of stopping
     it, per WCAG guidance that gentle, non-essential motion is fine. Needs
     the full shorthand + !important: app.css's global reduced-motion rule
     (`* { animation: none !important }`) otherwise wins over a bare
     animation-duration override and the gear goes fully static. */
  @media (prefers-reduced-motion: reduce) {
    .rb-cog {
      animation: icon-btn-spin 6s linear infinite !important;
    }
  }
  /* One deterministic-height line (min-width:0 so it can shrink inside .rb-head): it
     ellipsizes in a narrow pane rather than wrapping and pushing the head past the cap.
     The full text still reaches assistive tech via the banner's aria-live region. */
  .rb-text {
    display: block;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--color-ink-bright);
  }
  /* Tone → accent token. Calm = amber (matches the REVIEWING dot); escalated =
     warn; pasted/released = green; nothing/awaiting-go = slate (done); error = red. */
  .review-banner[data-tone="calm"] {
    --accent: var(--color-amber);
  }
  .review-banner[data-tone="escalated"] {
    --accent: var(--color-warn);
  }
  .review-banner[data-tone="pasted"],
  .review-banner[data-tone="released"] {
    --accent: var(--color-green);
  }
  .review-banner[data-tone="nothing"],
  .review-banner[data-tone="awaiting-go"] {
    --accent: var(--status-done);
  }
  .review-banner[data-tone="errored"] {
    --accent: var(--color-red);
  }
  @keyframes rb-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
