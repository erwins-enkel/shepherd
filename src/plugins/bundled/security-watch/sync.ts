// security-watch lifecycle sync, run after every poll over the issues we filed:
//  - an issue closed on the forge (by anyone) stops being synced;
//  - a CLAIMED one (a session was spawned for it, or the drain's claim label is on it) is left
//    alone: autonomy stops at the PR;
//  - an unclaimed one whose alerts are all gone from a COMPLETE read is closed with a comment.
// It only READS sessions: it has no way to steer, nudge or re-wake one (house rule).

import type { PluginIssues, PluginLogger, PluginSessions, PluginState } from "../../types";
import {
  readGroup,
  readGroups,
  writeGroup,
  type FiledIssue,
  type GroupRecord,
  type Source,
} from "./state";

/** Filed records synced per poll (oldest sync first): bounds forge calls. */
export const MAX_SYNC = 10;
/** The drain's claim label (mirrors core's `ACTIVE_LABEL`; plugins can't import core). */
const CLAIM_LABEL = "shepherd:active";

/** Generic on every repo: the comment may be public. */
export const RESOLVED_COMMENT =
  "The GitHub security alerts behind this issue are no longer open, so Shepherd is closing it. If they come back, Shepherd files a new issue.";

export interface SyncDeps {
  state: PluginState;
  issues: Pick<PluginIssues, "get" | "close">;
  sessions: Pick<PluginSessions, "list">;
  /** Was this repo + source read `ok` and not truncated in this poll? */
  complete: (repo: string, source: Source) => boolean;
  now: () => Date;
  log: PluginLogger;
}

type Open = GroupRecord & { filing: FiledIssue };

/** Merge `p` into the stored filing, unless the group was re-filed meanwhile. */
function patch(state: PluginState, key: string, number: number, p: Partial<FiledIssue>): void {
  const cur = readGroup(state, key);
  if (cur?.filing?.number === number) {
    writeGroup(state, { ...cur, filing: { ...cur.filing, ...p } });
  }
}

function claimed(d: SyncDeps, repo: string, number: number, labels: string[]): boolean {
  return (
    labels.includes(CLAIM_LABEL) ||
    d.sessions.list().some((s) => s.repoPath === repo && s.issueNumber === number)
  );
}

function allGone(d: SyncDeps, g: Open): boolean {
  if (!d.complete(g.repo, g.source)) return false;
  return !g.openAlerts.some((a) => g.filing.filedAlerts.includes(a.number));
}

async function syncOne(d: SyncDeps, g: Open): Promise<string> {
  const { number } = g.filing;
  const set = (p: Partial<FiledIssue>) => patch(d.state, g.key, number, p);
  set({ syncedAt: d.now().getTime() });
  const issue = await d.issues.get(g.repo, number);
  if (!issue) return "gh-unavailable";
  if (issue.state === "closed") {
    set({ sync: "closed" });
    return "gh-closed";
  }
  if (claimed(d, g.repo, number, issue.labels)) return "claimed";
  if (!allGone(d, g)) return "open";
  await d.issues.close(g.repo, number, RESOLVED_COMMENT);
  set({ sync: "closed" });
  d.log.log(`closed #${number} in ${g.repo}: alerts gone`);
  return "closed-resolved";
}

/** Sync up to {@link MAX_SYNC} open filings; returns outcome counts (`sync-*`). */
export async function syncFiled(d: SyncDeps): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const count = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  const due = readGroups(d.state)
    .filter((g): g is Open => g.filing?.sync === "open")
    .sort((a, b) => (a.filing.syncedAt ?? 0) - (b.filing.syncedAt ?? 0))
    .slice(0, MAX_SYNC);
  for (const g of due) {
    try {
      count(`sync-${await syncOne(d, g)}`);
    } catch (e) {
      d.log.warn(`sync ${g.key} failed: ${(e as Error).message}`);
      count("sync-error");
    }
  }
  return counts;
}
