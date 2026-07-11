// DRIFT: keep in sync with src/verdict-freshness.ts — the two are locked together by
// test/fixtures/verdict-stale-parity.json (read by both suites), like MERGE_MARK_BACKSTOP_MS.

/** The minimal git shape verdict-freshness reasons over (a subset of GitState / the server twin). */
export interface VerdictGit {
  state: "none" | "open" | "merged" | "closed";
  /** Head commit SHA of the PR branch; undefined when there is no PR. */
  headSha?: string | null;
}

/**
 * Whether a critic verdict is provably STALE — reviewed an older head than the PR's current one,
 * so it must NOT be treated as a live blocking verdict (the agent already pushed rework; a
 * re-review is pending).
 *
 * Asymmetric by design: the APPROVAL side (isReviewOk / readyToRetire) requires proof of
 * FRESHNESS (`verdictHead === currentHead`); the BLOCKING side is cleared only on proof of
 * STALENESS. So this returns true ONLY when a strictly-newer OPEN head is proven:
 *   git present ∧ state === "open" ∧ verdictHead present ∧ currentHead present ∧ verdictHead ≠ currentHead
 * Unknown git / absent-or-empty SHA / non-open PR ⇒ not proven stale ⇒ "don't advance on
 * uncertainty" (an empty-string head is UNKNOWN, not an older SHA).
 */
export function verdictStale(
  verdictHeadSha: string | null | undefined,
  git: VerdictGit | null | undefined,
): boolean {
  return (
    !!git &&
    git.state === "open" &&
    !!verdictHeadSha &&
    !!git.headSha &&
    verdictHeadSha !== git.headSha
  );
}
