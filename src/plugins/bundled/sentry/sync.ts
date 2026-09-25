// Sentry ⟷ GitHub lifecycle sync (#2466), run at the end of every poll over the issues we filed:
//  - writeback: a Sentry note linking the GitHub issue, and one linking the fix PR once a session
//    opens it (resolution stays Sentry-native via `Fixes <SHORTID>` + release commits);
//  - an UNCLAIMED GitHub issue is closed (with a comment) when Sentry resolved/ignored the error
//    or a human was assigned to it there. A claimed one is left alone.
// It only READS sessions — it has no way to steer, nudge or re-wake one (house rule).

import type { PluginIssues, PluginLogger, PluginSessions, PluginState } from "../../types";
import { parseIssueStatus, type SentryResult } from "./api";
import { listFiled, readFiled, writeFiled, type FiledRecord } from "./state";

/** Filed records synced per poll (oldest sync first) — bounds forge + Sentry calls. */
const MAX_SYNC = 10;
/** The drain's claim label (mirrors core's `ACTIVE_LABEL`; plugins can't import core). */
const CLAIM_LABEL = "shepherd:active";

const COMMENTS = {
  "sentry-resolved":
    "Sentry marked this error as resolved before any fix started, so Shepherd is closing this issue. If the error comes back, Shepherd files a new one.",
  "sentry-ignored": "Sentry marked this error as ignored, so Shepherd is closing this issue.",
  "human-assigned":
    "A person was assigned to this error in Sentry, so Shepherd is closing this issue to leave it to them.",
} as const;

type CloseReason = keyof typeof COMMENTS;

export interface SyncDeps {
  state: PluginState;
  issues: Pick<PluginIssues, "get" | "close">;
  sessions: Pick<PluginSessions, "list">;
  /** Sentry GET/POST that fold every response into the poll's backoff. */
  get: (path: string) => Promise<SentryResult>;
  post: (path: string, body: unknown) => Promise<SentryResult>;
  org: string;
  now: () => Date;
  log: PluginLogger;
}

class RateLimited extends Error {}

/** Sync up to MAX_SYNC open filed records; returns outcome counts (`sync-*`). */
export async function syncFiled(d: SyncDeps): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const count = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  const due = listFiled(d.state)
    .filter((f) => f.record.sync !== "closed")
    .sort((a, b) => (a.record.syncedAt ?? 0) - (b.record.syncedAt ?? 0))
    .slice(0, MAX_SYNC);
  for (const { sentryId, record } of due) {
    try {
      for (const outcome of await syncOne(d, sentryId, record)) count(`sync-${outcome}`);
    } catch (e) {
      if (e instanceof RateLimited) {
        count("sync-rate-limited");
        break;
      }
      d.log.warn(`sync ${sentryId} failed: ${(e as Error).message}`);
      count("sync-error");
    }
  }
  return counts;
}

/** Merge `p` into the stored record — unless it was re-filed meanwhile (a different filing). */
function patch(d: SyncDeps, sentryId: string, filedAt: string, p: Partial<FiledRecord>): void {
  const cur = readFiled(d.state, sentryId);
  if (cur?.filedAt === filedAt) writeFiled(d.state, sentryId, { ...cur, ...p });
}

function orgIssue(d: SyncDeps, sentryId: string, rest = ""): string {
  return `organizations/${encodeURIComponent(d.org)}/issues/${encodeURIComponent(sentryId)}/${rest}`;
}

/** Post a Sentry note; true once settled — posted, or refused for good (a 4xx such as a token
 *  without `event:write`), so it isn't retried every poll. A 429 aborts the whole pass. */
async function note(d: SyncDeps, sentryId: string, text: string): Promise<boolean> {
  const r = await d.post(orgIssue(d, sentryId, "notes/"), { text });
  if (r.status === 429) throw new RateLimited();
  if (r.ok) return true;
  const permanent = r.status >= 400 && r.status < 500;
  d.log.warn(`sentry note on ${sentryId} failed: ${r.error}${permanent ? " (not retried)" : ""}`);
  return permanent;
}

/** The newest session spawned for this GitHub issue, if any. */
function claimingSession(d: SyncDeps, r: FiledRecord) {
  return d.sessions
    .list()
    .filter((s) => s.repoPath === r.repo && s.issueNumber === r.number)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

/** Why Sentry says the (unclaimed) GitHub issue should close, or null. */
async function closeReason(d: SyncDeps, sentryId: string): Promise<CloseReason | null> {
  const r = await d.get(orgIssue(d, sentryId));
  if (r.status === 429) throw new RateLimited();
  const s = r.ok ? parseIssueStatus(r.data) : null;
  if (!s) return null;
  if (s.status === "resolved") return "sentry-resolved";
  if (s.status === "ignored") return "sentry-ignored";
  return s.assignee === "user" ? "human-assigned" : null;
}

async function syncOne(d: SyncDeps, sentryId: string, r: FiledRecord): Promise<string[]> {
  const out: string[] = [];
  const set = (p: Partial<FiledRecord>) => patch(d, sentryId, r.filedAt, p);
  set({ syncedAt: d.now().getTime() });

  const gh = await d.issues.get(r.repo, r.number);
  if (!gh) return ["gh-unavailable"];
  if (gh.state === "closed") {
    set({ sync: "closed" });
    return ["gh-closed"];
  }

  if (!r.notedIssue && (await note(d, sentryId, `Shepherd filed this error as ${r.url}`))) {
    set({ notedIssue: true });
    out.push("noted-issue");
  }

  const session = claimingSession(d, r);
  const pr = session?.pr;
  if (pr?.url && (pr.state === "open" || pr.state === "merged")) {
    set({ pr: { number: pr.number ?? null, url: pr.url } });
    if (r.notedPr !== pr.url && (await note(d, sentryId, `Shepherd opened a fix: ${pr.url}`))) {
      set({ notedPr: pr.url });
      out.push("noted-pr");
    }
  }

  if (session || gh.labels.includes(CLAIM_LABEL)) return [...out, "claimed"];

  const reason = await closeReason(d, sentryId);
  if (!reason) return out;
  await d.issues.close(r.repo, r.number, COMMENTS[reason]);
  set({ sync: "closed", closedReason: reason });
  d.log.log(`closed #${r.number} in ${r.repo}: ${reason}`);
  return [...out, reason];
}
