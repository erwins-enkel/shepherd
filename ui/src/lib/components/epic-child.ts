import type { EpicChild, Issue } from "#lib/types.js";

// Pure derivations for the epic-child detail (#2622): which run area it shows, what it waits
// on, what it frees, and the Issue handed to the New Task dialog for a manual start.

export type ChildView = "merged" | "session" | "standing";

/** Merged → a plain done state; running / in review → its session; else its standing in the
 *  epic (ready or blocked, not started). */
export function childView(child: Pick<EpicChild, "state">): ChildView {
  if (child.state === "merged") return "merged";
  if (child.state === "running" || child.state === "in-review") return "session";
  return "standing";
}

/** The child's blockers that aren't merged yet. A blocker outside the epic (not a sibling)
 *  counts as open — the record carries no state for it. */
export function openBlockers(
  child: Pick<EpicChild, "blockedBy">,
  siblings: readonly Pick<EpicChild, "number" | "state">[],
): number[] {
  return child.blockedBy.filter((b) => siblings.find((s) => s.number === b)?.state !== "merged");
}

/** Open siblings that wait on `child`, and how many of them become startable once it lands
 *  (no other open blocker) — the same rule as the epic run area's "parallel" count. */
export function childUnlocks(
  child: Pick<EpicChild, "number">,
  siblings: readonly Pick<EpicChild, "number" | "state" | "blockedBy">[],
): { unlocks: number[]; parallel: number } {
  const merged = new Set(siblings.filter((s) => s.state === "merged").map((s) => s.number));
  const dependents = siblings.filter(
    (s) => s.state !== "merged" && s.blockedBy.includes(child.number),
  );
  return {
    unlocks: dependents.map((s) => s.number),
    parallel: dependents.filter((s) =>
      s.blockedBy.every((b) => b === child.number || merged.has(b)),
    ).length,
  };
}

/** The Issue the New Task dialog attaches for a manual start: the listed open issue when the
 *  backlog has it, else one built from the epic record. `blockedBy` is always the epic's view
 *  of the open blockers, so the dialog can warn about starting out of order. */
export function childAsIssue(child: EpicChild, blockers: number[], listed?: Issue): Issue {
  const base: Issue = listed ?? {
    number: child.number,
    title: child.title,
    body: child.body,
    url: child.url,
    labels: [],
    createdAt: 0,
    assignees: [],
  };
  return { ...base, blockedBy: blockers };
}

/** Web URL of the child's PR: the session's live `git.url` when known, else the child's issue
 *  URL with the PR number swapped in (GitHub and Gitea redirect an issue URL whose number is a
 *  PR to that PR). Null without a PR. */
export function childPrUrl(
  child: Pick<EpicChild, "url" | "prNumber">,
  gitUrl?: string | null,
): string | null {
  if (child.prNumber == null) return null;
  if (gitUrl) return gitUrl;
  return /\d+$/.test(child.url) ? child.url.replace(/\d+$/, String(child.prNumber)) : null;
}
