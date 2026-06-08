import type { Session, GitState } from "$lib/types";

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
 *  parked sessions drop out (merged wins, fail-closed: no PR → nothing to run). */
export function collectReadyPrs(sessions: Session[], git: Record<string, GitState>): ReadyPr[] {
  const out: ReadyPr[] = [];
  for (const s of sessions) {
    if (!s.readyToMerge) continue;
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
export function formatReadyPrs(prs: ReadyPr[]): string {
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
