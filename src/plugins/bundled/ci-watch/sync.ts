// ci-watch lifecycle sync (#2542), run after every poll over the issues we filed:
//  - an issue closed on the forge (by anyone) stops being synced — the key's next red streak
//    re-files;
//  - an UNCLAIMED issue whose key went green since the filed run is closed with a comment;
//  - a CLAIMED one (a session was spawned for it, or the drain's claim label is on it) is left
//    alone: autonomy stops at the PR.
// It only READS sessions — it has no way to steer, nudge or re-wake one (house rule).

import type { PluginIssues, PluginLogger, PluginSessions, PluginState } from "../../types";
import { greenSince } from "./file";
import { readKey, writeKey, type FiledIssue, type KeyRecord } from "./state";

/** Filed records synced per poll (oldest sync first) — bounds forge calls. */
export const MAX_SYNC = 10;
/** The drain's claim label (mirrors core's `ACTIVE_LABEL`; plugins can't import core). */
const CLAIM_LABEL = "shepherd:active";

export const GREEN_COMMENT =
  "A later run of this CI job passed before any fix started, so Shepherd is closing this issue. If the job fails again, Shepherd files a new one.";

export interface SyncDeps {
  state: PluginState;
  issues: Pick<PluginIssues, "get" | "close">;
  sessions: Pick<PluginSessions, "list">;
  now: () => Date;
  log: PluginLogger;
}

type Open = { key: string; rec: KeyRecord & { filed: FiledIssue } };

function openFilings(state: PluginState): Open[] {
  const out: Open[] = [];
  for (const key of state.keys()) {
    if (!key.startsWith("map:")) continue;
    const rec = readKey(state, key);
    if (rec?.filed?.sync === "open") out.push({ key, rec: rec as Open["rec"] });
  }
  return out;
}

/** Merge `p` into the stored filing — unless the key was re-filed meanwhile. */
function patch(state: PluginState, key: string, number: number, p: Partial<FiledIssue>): void {
  const cur = readKey(state, key);
  if (cur?.filed?.number === number)
    writeKey(state, key, { ...cur, filed: { ...cur.filed, ...p } });
}

function claimed(d: SyncDeps, repo: string, number: number, labels: string[]): boolean {
  return (
    labels.includes(CLAIM_LABEL) ||
    d.sessions.list().some((s) => s.repoPath === repo && s.issueNumber === number)
  );
}

async function syncOne(d: SyncDeps, { key, rec }: Open): Promise<string> {
  const { number } = rec.filed;
  const set = (p: Partial<FiledIssue>) => patch(d.state, key, number, p);
  set({ syncedAt: d.now().getTime() });
  const issue = await d.issues.get(rec.repo, number);
  if (!issue) return "gh-unavailable";
  if (issue.state === "closed") {
    set({ sync: "closed" });
    return "gh-closed";
  }
  if (claimed(d, rec.repo, number, issue.labels)) return "claimed";
  if (!greenSince(rec, rec.filed.runId)) return "open";
  await d.issues.close(rec.repo, number, GREEN_COMMENT);
  set({ sync: "closed", closedReason: "green" });
  d.log.log(`closed #${number} in ${rec.repo}: ${rec.job} went green`);
  return "closed-green";
}

/** Sync up to {@link MAX_SYNC} open filings; returns outcome counts (`sync-*`). */
export async function syncFiled(d: SyncDeps): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const count = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  const due = openFilings(d.state)
    .sort((a, b) => (a.rec.filed.syncedAt ?? 0) - (b.rec.filed.syncedAt ?? 0))
    .slice(0, MAX_SYNC);
  for (const f of due) {
    try {
      count(`sync-${await syncOne(d, f)}`);
    } catch (e) {
      d.log.warn(`sync ${f.key} failed: ${(e as Error).message}`);
      count("sync-error");
    }
  }
  return counts;
}
