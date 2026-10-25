import type { Epic, EpicChild, EpicLanding, GitState } from "#lib/types.js";
import { childPrUrl } from "#lib/components/epic-child.js";

/** #3423: an incremental epic's children land through the merge train only when the repo is
 *  full-auto — autopilot AND auto-merge on, draftMode forcing the merge half off (mirrors the
 *  repo half of src/full-auto.ts `isFullAuto`). True when they wait for a human merge instead. */
export function mergeOff(cfg: { autoMerge: boolean; autopilot: boolean; draftMode: boolean }) {
  return cfg.draftMode || !cfg.autoMerge || !cfg.autopilot;
}

type RepoFlags = Record<string, boolean | undefined>;

/** {@link mergeOff} and the stack opt-in for `repoPath` from the per-repo config maps
 *  (`repoConfig` in reviews.svelte.ts); null until its config has loaded. */
export function repoMergeGate(
  cfg: {
    loaded: RepoFlags;
    autoMerge: RepoFlags;
    autopilot: RepoFlags;
    draftMode: RepoFlags;
    epicStacks: RepoFlags;
  },
  repoPath: string,
): { mergeOff: boolean; stacks: boolean } | null {
  if (!cfg.loaded[repoPath]) return null;
  return {
    mergeOff: mergeOff({
      autoMerge: !!cfg.autoMerge[repoPath],
      autopilot: !!cfg.autopilot[repoPath],
      draftMode: !!cfg.draftMode[repoPath],
    }),
    stacks: !!cfg.epicStacks[repoPath],
  };
}

/** An incremental epic with dependency edges whose children nobody merges: each `#n <- #m` edge
 *  advances only when the operator merges #m by hand. Stacked children (`epicStacksEnabled`) start on
 *  their predecessor's open PR, so the chain does not stall there. */
export function incrementalStallRisk(i: {
  landing: EpicLanding;
  hasEdges: boolean;
  mergeOff: boolean;
  stacks: boolean;
}): boolean {
  return i.landing === "incremental" && i.hasEdges && i.mergeOff && !i.stacks;
}

export interface AwaitingMerge {
  /** The blocker child whose PR waits for the operator's merge. */
  child: number;
  pr: number;
  url: string | null;
  /** Not-started children that start once it merges (no other open blocker). */
  blocks: number[];
}

/** Green, or no CI to wait on — a bare `none` without `noCi` is the pre-CI race, not cleared. */
const isGreen = (git: GitState) =>
  git.checks === "success" || (git.checks === "none" && !!git.noCi);

type GitFor = (sessionId: string) => GitState | null | undefined;

/** The child as a merge wait when it is in review with a green PR, else null. A child the drain
 *  retired (`retiredPrNumber`, session archived) counts as green: retire requires cleared checks
 *  and a mergeable PR, then leaves it open for a human merge — the usual waiting state here. */
function greenReview(c: EpicChild, gitFor: GitFor): AwaitingMerge | null {
  if (c.state !== "in-review") return null;
  if (c.sessionId == null && c.retiredPrNumber != null) {
    const pr = c.retiredPrNumber;
    return { child: c.number, pr, url: childPrUrl({ url: c.url, prNumber: pr }), blocks: [] };
  }
  if (c.prNumber == null || !c.sessionId) return null;
  const git = gitFor(c.sessionId);
  if (!git || !isGreen(git)) return null;
  return { child: c.number, pr: c.prNumber, url: git.url ?? null, blocks: [] };
}

/** The green child PRs a running incremental epic waits on a human merge for: each is an in-review
 *  child whose PR is green (or the repo has no CI) or that the drain retired, and it is listed
 *  with the blocked children whose every open blocker is such a PR. `gitFor` resolves a live
 *  child's session to its PR state; an unknown one is never listed. Empty unless `mergeOff`. */
export function awaitingMerge(
  epic: Pick<Epic, "run" | "children">,
  mergeOff: boolean,
  gitFor: GitFor,
): AwaitingMerge[] {
  if (!mergeOff || epic.run.landing !== "incremental" || epic.run.status !== "running") return [];
  const waiting = new Map<number, AwaitingMerge>();
  for (const c of epic.children) {
    const w = greenReview(c, gitFor);
    if (w) waiting.set(c.number, w);
  }
  const merged = new Set(epic.children.filter((c) => c.state === "merged").map((c) => c.number));
  for (const d of epic.children.filter((c) => c.state === "blocked")) {
    const open = d.blockedBy.filter((b) => !merged.has(b));
    if (open.length && open.every((b) => waiting.has(b))) {
      for (const b of open) waiting.get(b)!.blocks.push(d.number);
    }
  }
  return [...waiting.values()].filter((w) => w.blocks.length);
}
