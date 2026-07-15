import type { GitForge } from "./forge/types";
import type { Session, SessionArchiveReason } from "./types";
import type { SessionStore } from "./store";

/** Store surface for {@link recordEpicIntegrationIfChild}. */
export type EpicIntegrationStore = Pick<
  SessionStore,
  "getEpicRun" | "getEpicIntegrationBranch" | "recordEpicIntegrated"
>;

/** The merged PR's facts as the caller observed them (poller GitState / prCache / prStatus). */
export interface MergedPrFacts {
  number?: number | null;
  url?: string | null;
  /** The PR's actual base ref when the payload supplies it (GitHub); absent on Gitea/local. */
  baseRefName?: string | null;
}

/**
 * #1401: record `epic_integrated` for a merged epic-child PR on the settle paths that are NOT
 * the drain's retire path (poller reap of an out-of-band merge, merge train, local merge). Until
 * this existed, `retireEpicChild` was the only writer, so any other merge left the epic stalled
 * `running` forever (no completion, no landing PR).
 *
 * Call this BEFORE {@link settleMergedSession}: the just-written row is what its
 * `isIntegratedEpicChild` guard (#1037) reads to archive-only instead of closing the child
 * issue out of band.
 *
 * Deliberately NOT gated on `s.auto` — a manual (`auto=0`) respawn whose PR merges into the
 * integration branch is exactly the escape hatch that stalled pulse epic #128.
 *
 * Base resolution (the PR is the source of truth, not the session's stored base):
 *   1. `pr.baseRefName` from the caller's payload;
 *   2. number-keyed `forge.prReviewMeta` fallback;
 *   3. a forge that structurally cannot report a base (Gitea/local: no baseRefName, no
 *      prReviewMeta) falls back to `s.baseBranch` — the same trust `retireEpicChild` and the
 *      #645 `epicChildBaseBlocked` Gitea carve-out already extend;
 *   4. a base-CAPABLE forge whose base stays unresolvable fails closed (no record; the
 *      reconcile sweep retries later).
 *
 * Records only when the resolved base equals the PINNED integration branch (exact match —
 * divergent `epic/*` bases stay fail-closed; #645 warnings surface those). Best-effort: never
 * throws (the merge already happened; recording must not break teardown), and the store upsert
 * is idempotent so double-recording with the retire path is harmless.
 */
export async function recordEpicIntegrationIfChild(
  s: Session,
  pr: MergedPrFacts,
  deps: { store: EpicIntegrationStore; forge?: GitForge | null },
): Promise<void> {
  try {
    if (s.issueNumber == null) return;
    const run = deps.store.getEpicRun(s.repoPath);
    // Mirrors the retire path's epicActive gate — an idle/absent epic never records.
    if (!run || (run.status !== "running" && run.status !== "paused")) return;
    const pinned = deps.store.getEpicIntegrationBranch(s.repoPath, run.parentIssueNumber);
    if (pinned === null) return; // never pinned → this repo's epic never spawned a child
    if ((await resolveMergedBase(s, pr, deps.forge)) !== pinned) return;
    deps.store.recordEpicIntegrated(
      s.repoPath,
      run.parentIssueNumber,
      s.issueNumber,
      pr.number != null ? { number: pr.number, url: pr.url ?? "" } : undefined,
      pinned,
    );
  } catch (err) {
    console.warn(`[epic] record-integration failed for ${s.id} (issue #${s.issueNumber}):`, err);
  }
}

/** The merged PR's actual base per the resolution order documented on
 *  {@link recordEpicIntegrationIfChild}; null ⇒ unresolvable on a base-capable forge (fail closed). */
async function resolveMergedBase(
  s: Session,
  pr: MergedPrFacts,
  forge: GitForge | null | undefined,
): Promise<string | null> {
  if (pr.baseRefName != null) return pr.baseRefName;
  // Base-incapable forge (Gitea/local) — the #645-style carve-out trusts the session's base.
  if (!forge?.prReviewMeta) return s.baseBranch;
  // Base-capable forge: resolve number-keyed; an unresolvable base fails closed.
  if (pr.number == null) return null;
  return (await forge.prReviewMeta(pr.number))?.baseRefName || null;
}

export interface MergeTeardownDeps {
  resolveForge: (repoPath: string) => GitForge | null;
  /** service.archive */
  archive: (id: string, reason?: SessionArchiveReason) => Promise<number>;
  /** prPoller.drop */
  dropPrCache: (id: string) => void;
  /** events.emit("session:archived", {id}) */
  emitArchived: (id: string) => void;
  /** Mark the session so onArchived KEEPS its claim label (issue still open). */
  retainClaim: (id: string) => void;
  /** #1037: true when this session's issue is an integrated epic child (its PR already
   *  squash-merged into the epic's integration branch). Such a child must NEVER be closed
   *  out of band here — its issue closes only when the landing PR merges into the default
   *  branch. When true we archive + retain the claim and skip `closeIssue` entirely. */
  isIntegratedEpicChild: (s: Session) => boolean;
}

/**
 * Settle a session whose PR has merged (out-of-band OR by the merge train): close its
 * backlog issue, archive the session, drop the pr-cache, and emit archived. Best-effort:
 * the merge is already done, so a close failure must not block teardown — instead we
 * RETAIN the claim (issue still open → its label is what stops a re-spawn). Manual
 * sessions (no issue) skip the close/claim entirely.
 */
export async function settleMergedSession(s: Session, deps: MergeTeardownDeps): Promise<void> {
  let closed = false;
  // #1037: an integrated epic child is closed ONLY by the landing-PR merge (Closes #N into the
  // default branch). The merge here landed it into the integration branch, so closing now —
  // whether on a poller-observed merge mid-archive (the race) or on the archive-failure recovery
  // path — would close the child out of band, violating that invariant. Archive + retain the
  // claim (the still-open issue's label is what stops a re-spawn) and skip closeIssue entirely.
  if (s.auto && s.issueNumber != null && deps.isIntegratedEpicChild(s)) {
    deps.retainClaim(s.id);
    await deps.archive(s.id, "merged");
    deps.dropPrCache(s.id);
    deps.emitArchived(s.id);
    return;
  }
  if (s.auto && s.issueNumber != null) {
    const forge = deps.resolveForge(s.repoPath);
    // Gate on the method existing: a forge without closeIssue leaves the issue
    // OPEN, so we must not treat it as closed (see the claim-retain note below).
    if (forge?.closeIssue) {
      try {
        await forge.closeIssue(s.issueNumber);
        closed = true;
      } catch (err) {
        console.warn(`[merge] closeIssue #${s.issueNumber} failed for ${s.id}:`, err);
      }
    }
    // The issue closed → its claim is moot, so let onArchived drop the now-stale
    // label. If it did NOT close (close failed, or no closeIssue method), retain
    // the claim: the issue is still open and merged, so the label is what stops
    // any instance re-spawning already-merged work.
    if (!closed) deps.retainClaim(s.id);
  }
  await deps.archive(s.id, "merged");
  deps.dropPrCache(s.id);
  deps.emitArchived(s.id);
}
