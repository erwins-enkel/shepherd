import { m } from "$lib/paraglide/messages";
import type { Session, GitState, CreateInput } from "$lib/types";

/** Merge-train marks older than this read as stale (the row falls back to its
 *  prior state) so a stuck PR never sticks visually even if the server's TTL
 *  sweep is briefly behind. Mirrors MERGE_STALE_MS in src/service.ts. */
export const MERGE_STALE_MS = 30 * 60_000;

/** True when a session is in a currently-running merge train: marked and the
 *  mark is still within the TTL. `now` injectable for tests. */
export function isMerging(s: Session, now: number = Date.now()): boolean {
  return s.mergingSince !== null && now - s.mergingSince < MERGE_STALE_MS;
}

/** A ready-to-merge session's open PR, the unit a merge train works through. */
export interface ReadyPr {
  sessionId: string;
  number: number;
  title: string;
  url: string;
  repoPath: string;
}

/** Ready-to-merge sessions that currently have an OPEN PR — the merge-train
 *  targets. Mirrors the `ready` partition (operator-parked `readyToMerge`),
 *  intersected with an open PR from git state so already-merged or PR-less
 *  parked sessions drop out (merged wins, fail-closed: no PR → nothing to run).
 *  Sessions whose review is still in flight (`isReviewing`) are also excluded —
 *  the work isn't settled, so the train must neither count nor land them; the
 *  injected predicate (mirrors `partitionSessions`) keeps the link's count and
 *  the launch action in agreement. Default `() => false` preserves 2-arg callers. */
export function collectReadyPrs(
  sessions: Session[],
  git: Record<string, GitState>,
  isReviewing: (id: string) => boolean = () => false,
): ReadyPr[] {
  const out: ReadyPr[] = [];
  for (const s of sessions) {
    if (!s.readyToMerge) continue;
    if (isReviewing(s.id)) continue; // review in flight → not settled, don't run the train over it
    const g = git[s.id];
    if (g?.state !== "open" || g.number == null) continue;
    out.push({
      sessionId: s.id,
      number: g.number,
      title: g.title ?? "",
      url: g.url ?? "",
      repoPath: s.repoPath,
    });
  }
  return out;
}

/** Render the PR list for the kickoff prompt: one `- #<n> <title> — <url>`
 *  bullet per PR, gracefully dropping an absent title or url. */
export function formatReadyPrs(prs: Pick<ReadyPr, "number" | "title" | "url">[]): string {
  return prs
    .map((p) => {
      let line = `- #${p.number}`;
      if (p.title) line += ` ${p.title}`;
      if (p.url) line += ` — ${p.url}`;
      return line;
    })
    .join("\n");
}

/** Scope a multi-repo set of ready PRs to a single merge-train repo: the repo
 *  with the most ready PRs (ties → first encountered). A merge train is
 *  inherently per-repo, so PRs in other repos are reported (`otherRepoCount`)
 *  for a fail-loud notice rather than silently folded in. */
export function pickTrainRepo(prs: ReadyPr[]): {
  repoPath: string | null;
  prs: ReadyPr[];
  otherRepoCount: number;
} {
  if (prs.length === 0) return { repoPath: null, prs: [], otherRepoCount: 0 };
  const byRepo = new Map<string, ReadyPr[]>();
  for (const p of prs) {
    const list = byRepo.get(p.repoPath);
    if (list) list.push(p);
    else byRepo.set(p.repoPath, [p]);
  }
  let bestRepo = prs[0].repoPath;
  let best = byRepo.get(bestRepo)!;
  for (const [repo, list] of byRepo) {
    if (list.length > best.length) {
      bestRepo = repo;
      best = list;
    }
  }
  return { repoPath: bestRepo, prs: best, otherRepoCount: prs.length - best.length };
}

/** Build the `createSession` input for a merge-train kickoff. Pure (no I/O, no
 *  side effects) so the gate-skip invariant is locked by `merge-train.test.ts`.
 *
 *  Two framings:
 *  - `handpicked=false` (default): the PRs were operator-flagged readyToMerge —
 *    uses `herd_merge_train_prompt` which says "I've flagged ready to merge".
 *  - `handpicked=true`: the user hand-selected PRs from the backlog PRs panel —
 *    uses `prspanel_merge_train_prompt` which says "I've selected", making no
 *    false claim about readiness status. */
export function mergeTrainCreateInput(
  repoPath: string,
  baseBranch: string,
  prs: Pick<ReadyPr, "number" | "title" | "url">[],
  handpicked = false,
): CreateInput {
  const formatted = formatReadyPrs(prs);
  return {
    repoPath,
    baseBranch,
    prompt: handpicked
      ? m.prspanel_merge_train_prompt({ prs: formatted })
      : m.herd_merge_train_prompt({ prs: formatted }),
    model: null,
    // Merge train is a procedural land-the-queue task, never a feature plan —
    // always skip the plan gate regardless of the per-repo toggle.
    planGateEnabled: false,
  };
}

/** Return the `sessionId`s of ready-to-merge sessions whose open PR number is
 *  in `numbers` AND whose `repoPath` matches.
 *
 *  Selects **only `readyToMerge`** sessions (mirroring `onmergetrain`), so an
 *  in-progress session's PR not appearing here is deliberate, not a bug. */
export function sessionsForPrNumbers(
  repoPath: string,
  numbers: number[],
  sessions: Session[],
  git: Record<string, GitState>,
  isReviewing: (id: string) => boolean = () => false,
): string[] {
  const numberSet = new Set(numbers);
  return collectReadyPrs(sessions, git, isReviewing)
    .filter((p) => p.repoPath === repoPath && numberSet.has(p.number))
    .map((p) => p.sessionId);
}
