import {
  buildRollup,
  completedEpicRows,
  incrementalRollup,
  isSucceededOutcome,
  publicCompletedEpic,
  type CompletedEpic,
} from "./completed-epic";
import { effectiveEpicLanding, type Epic, type EpicRun } from "./epic-core";
import type { EventHub } from "./events";
import type { GitForge } from "./forge/types";
import type { SessionStore } from "./store";

/** What the completed-epics reconcile reads and writes. `AppDeps` satisfies it structurally. */
export interface CompletedEpicsReconcileDeps {
  store: Pick<
    SessionStore,
    | "listEpicCompleted"
    | "settleEpicClosedUnlanded"
    | "setEpicLandingPr"
    | "markEpicIncrementalSucceeded"
    | "getEpicIntegrationBranch"
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

// A completed epic whose parent is confidently closed (absent from a complete open set) settles
// (#3838): a landing PR found merged makes it a success, which stays in the band until the
// operator acknowledges it; anything else closed without landing and leaves the band. A success
// is never touched. openTruncated → can't be confident, so this is a no-op.
async function settleClosedParents(
  deps: CompletedEpicsReconcileDeps,
  repo: string,
  forge: GitForge,
  openNumbers: Set<number>,
  openTruncated: boolean,
): Promise<void> {
  if (openTruncated) return;
  for (const row of deps.store.listEpicCompleted(repo)) {
    const parent = row.parentIssueNumber;
    if (openNumbers.has(parent) || isSucceededOutcome(row.outcome)) continue;
    const landed = await landingMerged(deps, forge, row);
    if (landed === undefined) continue; // forge read failed — the next reconcile retries
    if (landed) {
      deps.store.setEpicLandingPr(repo, parent, { ...landed, attempts: row.landingAttempts });
      const pushed = completedEpicRows(deps.store, repo).find(
        (r) => r.parentIssueNumber === parent,
      );
      if (pushed) deps.events?.emit("epic:completed", publicCompletedEpic(pushed));
      continue;
    }
    deps.store.settleEpicClosedUnlanded(repo, parent);
    deps.events?.emit("epic:completed-cleared", { repoPath: repo, parentIssueNumber: parent });
  }
}

/** The merged landing PR of a closed-parent row — the landing PR's own `Closes #<parent>` closes
 *  the parent, often before the drain observed the merge. Null when nothing landed; undefined when
 *  the forge could not be read. */
async function landingMerged(
  deps: CompletedEpicsReconcileDeps,
  forge: GitForge,
  row: ReturnType<SessionStore["listEpicCompleted"]>[number],
): Promise<{ state: "merged"; prNumber: number | null; prUrl: string | null } | null | undefined> {
  if (row.landingState === "merged")
    return { state: "merged", prNumber: row.landingPrNumber, prUrl: row.landingPrUrl };
  const branch = deps.store.getEpicIntegrationBranch(row.repoPath, row.parentIssueNumber);
  if (branch === null) return null;
  try {
    const pr = await forge.prStatus(branch);
    if (pr.state !== "merged") return null;
    return {
      state: "merged",
      prNumber: pr.number ?? row.landingPrNumber,
      prUrl: pr.url ?? row.landingPrUrl,
    };
  } catch {
    return undefined;
  }
}

// Backfill: an idle run whose all-merged epic never got recorded (e.g. completion happened
// across a restart). Needs buildEpic — no-op when drain is absent. Records the completed epic
// when all children are merged; otherwise logs a visible skip (never silently dropped).
// #3191/#3838: an incremental epic records its success and retries closing the still-open parent.
async function backfillIdleEpic(
  deps: CompletedEpicsReconcileDeps,
  repo: string,
  forge: GitForge,
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
  // it's about to be settled anyway — skip the flash of recording it.
  if (!openTruncated && !openNumbers.has(run.parentIssueNumber)) return;

  const epic = await deps.drain.buildEpic(repo, run);
  if (!epic || epic.children.length === 0) return;
  const pending = epic.children.filter((c) => c.state !== "merged").map((c) => c.number);
  if (pending.length > 0) {
    // Visible skip — never silently drop a backfill candidate.
    console.warn(
      `[server] completed-epics backfill skipped for ${repo}#${run.parentIssueNumber}: ` +
        `children not all merged (pending: ${pending.join(", ")})`,
    );
    return;
  }
  const incremental = effectiveEpicLanding(run) === "incremental";
  recordBackfilledEpic(deps, repo, run, epic, incremental);
  if (incremental && !openTruncated)
    await closeIncrementalParent(forge, repo, run.parentIssueNumber);
}

/** #3191: retry closing an all-merged incremental epic's parent (the drain's close failed, or
 *  completion happened across a restart). Best-effort: a failure only logs, the next reconcile
 *  retries while the parent stays open. */
async function closeIncrementalParent(forge: GitForge, repo: string, parent: number) {
  try {
    await forge.closeIssue?.(parent);
  } catch (err) {
    console.warn(`[server] closing incremental epic ${repo}#${parent} failed:`, err);
  }
}

function recordBackfilledEpic(
  deps: CompletedEpicsReconcileDeps,
  repo: string,
  run: EpicRun,
  epic: Epic,
  incremental: boolean,
): void {
  const rollup = incremental
    ? incrementalRollup(epic.children)
    : buildRollup(epic.children, deps.store.listEpicIntegratedDetails(repo, run.parentIssueNumber));
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
  deps.store.recordEpicCompleted(
    {
      repoPath: completed.repoPath,
      parentIssueNumber: completed.parentIssueNumber,
      parentTitle: completed.parentTitle,
      completedAt: completed.completedAt,
      childrenJson: JSON.stringify(rollup),
    },
    { stampLanding: !incremental },
  );
  if (incremental)
    deps.store.markEpicIncrementalSucceeded(repo, run.parentIssueNumber, completedAt);
}

/**
 * Bounded, best-effort, fail-safe per-repo reconcile: resolve the forge (skip if none), fetch
 * the open set (forge throw → skip this repo; its DB rows are still served), then settle
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

  await settleClosedParents(deps, repo, forge, openNumbers, openTruncated);
  await backfillIdleEpic(deps, repo, forge, openNumbers, openTruncated);
}
