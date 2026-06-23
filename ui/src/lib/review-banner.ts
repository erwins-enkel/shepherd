import type { PlanDecision, ReviewDecision, ReviewVerdict } from "./types";

// Pure state selection for the review-in-flight terminal banner (issue #1022),
// mirroring the critic-badge.ts / plan-gate-badge.ts pattern so the predicate is
// unit-testable without rendering. The stateful bits (sticky escalation, the
// prior-round snapshot, the conclusion auto-dismiss timer) live in the component;
// this module is given their resolved values and maps them to a banner descriptor.

/** Which review a banner could be about. */
export type ReviewKind = "critic" | "plangate";

/** The outcome a concluded review resolves to (drives the conclusion-tier copy). */
export type ConclusionOutcome =
  | "pasted" // a directive was steered into the live PTY
  | "nothing" // review done, nothing pasted (clean/comment, or a steer that didn't land)
  | "released" // plan approved + auto/autopilot → released into execution
  | "awaiting-go" // plan approved, interactive → nothing pasted, awaiting operator Go
  | "errored"; // review errored, nothing pasted

/** Resolved banner descriptor. `tone` is a semantic key the component maps to a
 *  design token; `copyKey` is the i18n message key for the banner text. */
export type BannerState =
  | { show: false }
  | {
      show: true;
      phase: "in-flight";
      tone: "calm" | "escalated";
      copyKey: "reviewbanner_calm" | "reviewbanner_escalated";
    }
  | {
      show: true;
      phase: "conclusion";
      tone: ConclusionOutcome;
      copyKey:
        | "reviewbanner_pasted"
        | "reviewbanner_nothing"
        | "reviewbanner_released"
        | "reviewbanner_awaiting_go"
        | "reviewbanner_errored";
    };

/**
 * Whether the critic in-flight banner should show. True iff auto-address is on
 * for the repo AND the streak is under its cap. The cap is only knowable from a
 * verdict (it rides on `addressCap`); with no prior verdict treat the round as 0,
 * which is under any positive cap, so the banner shows. There is no global-cap
 * fallback — `prReviewCyclesCap` is a Settings value, not on the repo-config store.
 */
export function criticInFlightShows(
  autoAddressOn: boolean,
  verdict: Pick<ReviewVerdict, "addressRound" | "addressCap"> | undefined,
): boolean {
  if (!autoAddressOn) return false;
  if (!verdict) return true; // no prior verdict → round 0 < cap
  return verdict.addressRound < verdict.addressCap;
}

/**
 * The outcome a concluded review resolves to. Derived from whether the steer was
 * actually `delivered` (the round advanced past the in-flight-entry snapshot),
 * NOT from re-derived toggle predicates — the server also gates a paste on
 * PR-open and a live pane, both of which are captured by round advancement. So a
 * closed-PR / dead-pane run correctly reads "nothing" instead of a false "pasted".
 *
 * @param decision   the verdict/gate decision
 * @param delivered  newRound > snapshotRound (the steer actually landed)
 * @param isPlanGate plan-gate (true) vs critic (false)
 * @param autoReleased plan-gate only: session.auto || effectiveAutopilot
 */
export function conclusionOutcome(
  decision: ReviewDecision | PlanDecision | undefined,
  delivered: boolean,
  isPlanGate: boolean,
  autoReleased: boolean,
): ConclusionOutcome {
  if (decision === "error") return "errored";
  if (delivered) return "pasted";
  if (isPlanGate && decision === "approved") {
    return autoReleased ? "released" : "awaiting-go";
  }
  return "nothing";
}

const CONCLUSION_COPY: Record<ConclusionOutcome, BannerState & { show: true }> = {
  pasted: { show: true, phase: "conclusion", tone: "pasted", copyKey: "reviewbanner_pasted" },
  nothing: { show: true, phase: "conclusion", tone: "nothing", copyKey: "reviewbanner_nothing" },
  released: { show: true, phase: "conclusion", tone: "released", copyKey: "reviewbanner_released" },
  "awaiting-go": {
    show: true,
    phase: "conclusion",
    tone: "awaiting-go",
    copyKey: "reviewbanner_awaiting_go",
  },
  errored: { show: true, phase: "conclusion", tone: "errored", copyKey: "reviewbanner_errored" },
};

/** Inputs the component resolves and feeds to the banner descriptor builder. */
export interface ReviewBannerInput {
  /** Which review is (or was) running; null when neither applies. */
  kind: ReviewKind | null;
  /** "in-flight" while reviewing; "conclusion" during the post-verdict window. */
  phase: "in-flight" | "conclusion";
  /** Sticky "operator typed during this review" flag (in-flight only). */
  escalated: boolean;
  /** Critic in-flight gating: auto-address on for the repo. */
  autoAddressOn: boolean;
  /** Critic in-flight gating: latest verdict (for round/cap), if any. */
  verdict: Pick<ReviewVerdict, "addressRound" | "addressCap"> | undefined;
  /** Conclusion: the resolved decision. */
  decision: ReviewDecision | PlanDecision | undefined;
  /** Conclusion: whether the steer landed (round advanced past entry snapshot). */
  delivered: boolean;
  /** Conclusion (plan-gate): session.auto || effectiveAutopilot. */
  autoReleased: boolean;
}

/**
 * The single entry point the component uses. Resolves whether the banner shows,
 * its phase, tone and copy key from the component-tracked inputs.
 */
export function reviewBannerState(input: ReviewBannerInput): BannerState {
  if (input.kind == null) return { show: false };

  if (input.phase === "conclusion") {
    const outcome = conclusionOutcome(
      input.decision,
      input.delivered,
      input.kind === "plangate",
      input.autoReleased,
    );
    return CONCLUSION_COPY[outcome];
  }

  // in-flight: critic is gated on auto-address + cap; plan-gate always shows.
  if (input.kind === "critic" && !criticInFlightShows(input.autoAddressOn, input.verdict)) {
    return { show: false };
  }
  return input.escalated
    ? { show: true, phase: "in-flight", tone: "escalated", copyKey: "reviewbanner_escalated" }
    : { show: true, phase: "in-flight", tone: "calm", copyKey: "reviewbanner_calm" };
}
