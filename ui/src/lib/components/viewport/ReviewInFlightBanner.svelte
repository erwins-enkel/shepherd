<script lang="ts">
  import type { Session } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { reviews, planGates, repoConfig } from "$lib/reviews.svelte";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import { reviewBannerState, type BannerState, type ReviewKind } from "$lib/review-banner";

  // Non-blocking signal that an in-flight PR-critic / plan-gate review may steer
  // this session when it concludes (issue #1022). Shown only when a paste could
  // actually land per current toggles; escalates if the operator types mid-review;
  // flips to a brief auto-dismissing conclusion tier. The future stage-and-apply
  // guard is out of scope — this is the signal only.
  let { session, keystrokes, tab }: { session: Session; keystrokes: number; tab: string } =
    $props();

  // Live in-flight flags (mutually exclusive: plan-gate = planning phase, critic =
  // post-PR, so never both at once).
  const criticReviewing = $derived(reviews.isReviewing(session.id));
  const planReviewing = $derived(planGates.isReviewing(session.id));
  const liveKind = $derived<ReviewKind | null>(
    criticReviewing ? "critic" : planReviewing ? "plangate" : null,
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
  const view = $derived<BannerState>(
    conclusion ??
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

  function bannerText(s: BannerState): string {
    if (!s.show) return "";
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
</script>

{#if view.show && tab === "term"}
  <div
    class="review-banner"
    data-tone={view.tone}
    role="status"
    aria-live="polite"
    use:coachTarget={"review-inflight"}
  >
    <span class="rb-icon" aria-hidden="true">{icon}</span>
    <span class="rb-text">{bannerText(view)}</span>
  </div>
{/if}

<style>
  /* Bottom overlay strip pinned to the terminal body, directly above the steer
     bar. Absolutely positioned so it never triggers an xterm refit. Non-blocking:
     no scrim/blur — it does not seize interaction. */
  .review-banner {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    font-size: var(--fs-meta);
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, var(--color-head));
    border-top: 1px solid color-mix(in srgb, var(--accent) 55%, var(--color-line));
    backdrop-filter: blur(2px);
    animation: rb-in 0.14s ease;
  }
  .rb-icon {
    font-size: var(--fs-base);
    line-height: 1;
  }
  .rb-text {
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
