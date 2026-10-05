import { buildRollup, type CompletedEpic } from "./completed-epic";
import type { Epic, EpicRun } from "./epic-core";
import type { EventHub } from "./events";
import type { GitForge } from "./forge/types";
import type { SessionStore } from "./store";

/** What the completed-epics reconcile reads and writes. `AppDeps` satisfies it structurally. */
export interface CompletedEpicsReconcileDeps {
  store: Pick<
    SessionStore,
    | "listEpicCompleted"
    | "dismissEpicCompleted"
    | "listEpicRuns"
    | "getEpicRun"
    | "hasEpicCompleted"
    | "listEpicIntegratedDetails"
    | "recordEpicCompleted"
  >;
  events?: Pick<EventHub, "emit">;
  drain?: { buildEpic(repoPath: string, run: EpicRun): Promise<Epic | null> };
  resolveForge?: (repoDir: string) => GitForge | null;
}

/** The repos the reconcile covers: those with a completed-epic row, plus those with an idle
 *  epic run (the backfill source). One entry per repo — bounded. */
export function completedEpicScopeRepos(store: CompletedEpicsReconcileDeps["store"]): string[] {
  return [
    ...new Set([
      ...store.listEpicCompleted().map((r) => r.repoPath),
      ...store
        .listEpicRuns()
        .filter((r) => r.status === "idle")
        .map((r) => r.repoPath),
    ]),
  ];
}

// Auto-dismiss: a completed epic whose parent is confidently closed (absent from a complete
// open set) gets cleared + emitted. openTruncated → can't be confident, so this is a no-op.
function autoDismissClosed(
  deps: CompletedEpicsReconcileDeps,
  repo: string,
  openNumbers: Set<number>,
  openTruncated: boolean,
): void {
  if (openTruncated) return;
  for (const row of deps.store.listEpicCompleted(repo)) {
    if (!openNumbers.has(row.parentIssueNumber)) {
      deps.store.dismissEpicCompleted(repo, row.parentIssueNumber);
      deps.events?.emit("epic:completed-cleared", {
        repoPath: repo,
        parentIssueNumber: row.parentIssueNumber,
      });
    }
  }
}

// Backfill: an idle run whose all-merged epic never got recorded (e.g. completion happened
// across a restart). Needs buildEpic — no-op when drain is absent. Records the completed epic
// when all children are merged; otherwise logs a visible skip (never silently dropped).
async function backfillIdleEpic(
  deps: CompletedEpicsReconcileDeps,
  repo: string,
  openNumbers: Set<number>,
  openTruncated: boolean,
): Promise<void> {
  if (!deps.drain) return;
  const run = deps.store.getEpicRun(repo);
  if (run?.status !== "idle") return;
  // hasEpicCompleted ignores dismissedAt, so a dismissed-but-idle run counts as recorded
  // and never re-fires buildEpic (a forge round-trip) on every reconcile.
  if (deps.store.hasEpicCompleted(repo, run.parentIssueNumber)) return;
  // Parent confidently still open? If we have a complete open set and the parent is absent,
  // it's about to be auto-dismissed anyway — skip the flash of recording it.
  if (!openTruncated && !openNumbers.has(run.parentIssueNumber)) return;

  const epic = await deps.drain.buildEpic(repo, run);
  if (!epic || epic.children.length === 0) return;
  if (epic.children.every((c) => c.state === "merged")) {
    const rollup = buildRollup(
      epic.children,
      deps.store.listEpicIntegratedDetails(repo, run.parentIssueNumber),
    );
    // completedAt: latest non-null child mergedAt, else now (not in the sync pump → Date.now OK).
    const mergedAts = rollup.map((c) => c.mergedAt).filter((m): m is number => m !== null);
    const completedAt = mergedAts.length > 0 ? Math.max(...mergedAts) : Date.now();
    const completed: CompletedEpic = {
      repoPath: repo,
      parentIssueNumber: run.parentIssueNumber,
      parentTitle: epic.parentTitle,
      completedAt,
      children: rollup,
      // A backfilled completion (e.g. across a restart) is recorded as pending — its final
      // state here; the autonomous drain tick (ensureLandingPrsForRepo) opens the landing PR.
      landingPrNumber: null,
      landingPrUrl: null,
      landingState: "pending",
      migrationPaths: [],
      migrationsAckedAt: null,
      landingRebasePauseReason: null,
      landingRepairCount: 0,
      landingRepairHead: null,
      landingConflictReworkCount: 0,
    };
    deps.store.recordEpicCompleted({
      repoPath: completed.repoPath,
      parentIssueNumber: completed.parentIssueNumber,
      parentTitle: completed.parentTitle,
      completedAt: completed.completedAt,
      childrenJson: JSON.stringify(rollup),
    });
  } else {
    // Visible skip — never silently drop a backfill candidate.
    const pending = epic.children.filter((c) => c.state !== "merged").map((c) => c.number);
    console.warn(
      `[server] completed-epics backfill skipped for ${repo}#${run.parentIssueNumber}: ` +
        `children not all merged (pending: ${pending.join(", ")})`,
    );
  }
}

/**
 * Bounded, best-effort, fail-safe per-repo reconcile: resolve the forge (skip if none), fetch
 * the open set (forge throw → skip this repo; its DB rows are still served), then auto-dismiss
 * confidently-closed parents + backfill an all-merged idle run that never got recorded.
 *
 * Runs when the repo's issues change (#2756: the fingerprint observed it) — and, for a repo no
 * fingerprint covers, from GET /api/epics/completed as before.
 */
export async function reconcileCompletedEpicsForRepo(
  deps: CompletedEpicsReconcileDeps,
  repo: string,
): Promise<void> {
  const forge = deps.resolveForge?.(repo);
  if (!forge) return; // no forge → skip reconcile for this repo (its DB rows are still served)

  let open: Awaited<ReturnType<GitForge["listIssues"]>>;
  try {
    open = await forge.listIssues();
  } catch {
    return; // forge/network error → skip this repo's reconcile (fail-safe)
  }
  const openNumbers = new Set(open.map((i) => i.number));
  const openTruncated = open.length >= 200;

  autoDismissClosed(deps, repo, openNumbers, openTruncated);
  await backfillIdleEpic(deps, repo, openNumbers, openTruncated);
}
