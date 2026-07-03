import type { GitState } from "./types";

// Pure state selection for the terminal "CI is running" banner, mirroring the
// review-banner.ts / critic-badge.ts pattern so the predicate is unit-testable
// without rendering. The banner is a non-blocking amber strip at the bottom of the
// terminal (the same spot as ReviewInFlightBanner), leading with the rotating gear
// to signal "CI is running — hold off". It yields the strip to the review-in-flight
// banner (the more urgent, steering signal): CI is suppressed while that banner is
// logically visible, so the two are mutually exclusive by construction.

/** Resolved CI-banner descriptor. `names` are the running checks in the forge's
 *  `"<workflow> / <job>"` format (may be empty → the component shows the unnamed
 *  fallback copy). */
export type CiBannerState =
  { show: false } | { show: true; number?: number; url?: string; names: string[] };

export interface CiBannerInput {
  /** This session's live PR/CI state, or null/undefined when there's no PR. */
  git: GitState | null | undefined;
  /** The review-in-flight banner is logically occupying the strip. When true the
   *  CI banner suppresses itself so only one strip ever shows. */
  reviewActive: boolean;
}

/**
 * Whether the CI-running banner shows, and with what. True iff the session has an
 * open PR whose checks are still in flight (`pending`) and no review banner is
 * currently claiming the strip. No `noCi` guard is needed: `noCi` is exactly the
 * "zero workflows → checks:none" case, so it can't co-occur with `checks:"pending"`.
 */
export function ciBannerState(input: CiBannerInput): CiBannerState {
  const { git, reviewActive } = input;
  if (reviewActive) return { show: false };
  if (!git || git.state !== "open" || git.checks !== "pending") return { show: false };
  return { show: true, number: git.number, url: git.url, names: git.runningChecks ?? [] };
}
