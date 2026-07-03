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
 * Whether the CI-running banner shows, and with what. Shows iff the session has an
 * open PR with CI still in flight and no review banner is claiming the strip.
 *
 * "In flight" is two signals OR'd: the aggregate `checks === "pending"` (the only
 * one on the REST/Gitea fallback, where `runningChecks` is absent), AND a non-empty
 * `runningChecks`. The second matters because GitHub's worst-of rollup flips
 * `checks` to `"failure"` the moment ONE check fails while others keep running — so
 * keying on `checks === "pending"` alone would hide the banner mid-run on the first
 * failure, exactly when the operator still shouldn't act. No `noCi` guard is needed:
 * `noCi` is the "zero workflows → checks:none, runningChecks empty" case, which
 * neither branch matches.
 */
export function ciBannerState(input: CiBannerInput): CiBannerState {
  const { git, reviewActive } = input;
  if (reviewActive) return { show: false };
  if (!git || git.state !== "open") return { show: false };
  const names = git.runningChecks ?? [];
  if (git.checks !== "pending" && names.length === 0) return { show: false };
  return { show: true, number: git.number, url: git.url, names };
}
