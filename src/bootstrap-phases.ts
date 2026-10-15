/**
 * Bootstrap phase sequencer (#3112, epic #3114): leads an active-bootstrap repo P1+P2 → P3 → P4
 * → exit. The phase advances on a bootstrap session's merge (src/greenfield.ts → onMerged) and on
 * the P4 epic's materialization ({@link advanceAfterEpicApproved}); each advance only PROPOSES the
 * next attended session ({@link bootstrapNextStep}) — nothing is spawned without the operator.
 *
 * Restart-safe: the phase lives in `repo_bootstrap`, and {@link reconcileBootstrapPhases} re-derives
 * any advance a crash lost from persisted facts (merged bootstrap sessions, approved epic drafts)
 * newer than the phase's start. It never moves a phase backwards.
 */
import {
  BOOTSTRAP_LAST_PHASE,
  bootstrapMissing,
  hasProjectManifest,
  type BootstrapSessionPhase,
  type RepoBootstrap,
} from "./bootstrap";
import type { SessionStore } from "./store";

/** What the operator starts next: a bootstrap session (P1+P2 or P3), the P4 epic authoring, or —
 *  phases done — the Readiness tab for the red must-haves. */
export type BootstrapNextKind = "bootstrap" | "epic" | "readiness";

export interface BootstrapNextStep {
  kind: BootstrapNextKind;
  /** The repo phase this step completes (1 = P1+P2, 3, 4, 5 = exit check). */
  phase: number;
  /** A live session already doing this step — the UI opens it instead of starting another. */
  sessionId: string | null;
}

/** A live (non-archived) session of the repo, reduced to what the next step needs. */
export interface LiveBootstrapSession {
  id: string;
  bootstrapPhase: BootstrapSessionPhase | null;
  epicAuthoring: boolean;
}

function kindFor(phase: number): BootstrapNextKind {
  if (phase <= 3) return "bootstrap";
  return phase === 4 ? "epic" : "readiness";
}

/** The next step of an ACTIVE bootstrap; null when the repo is off or done. */
export function bootstrapNextStep(
  b: RepoBootstrap,
  live: readonly LiveBootstrapSession[],
): BootstrapNextStep | null {
  if (b.state !== "active") return null;
  const kind = kindFor(b.phase);
  const sessionPhase: BootstrapSessionPhase = b.phase >= 3 ? 3 : 1;
  const running = live.find((s) =>
    kind === "bootstrap"
      ? s.bootstrapPhase === sessionPhase
      : kind === "epic" && s.epicAuthoring && s.bootstrapPhase == null,
  );
  return { kind, phase: b.phase, sessionId: running?.id ?? null };
}

type ViewStore = Pick<SessionStore, "getRepoBootstrap" | "list" | "getBootstrapPhase">;

/** The repo's live sessions as {@link LiveBootstrapSession}s. */
function liveSessions(store: ViewStore, dir: string): LiveBootstrapSession[] {
  return store
    .list({ activeOnly: true })
    .filter((s) => s.repoPath === dir)
    .map((s) => ({
      id: s.id,
      bootstrapPhase: s.bootstrap ? store.getBootstrapPhase(s.id) : null,
      epicAuthoring: s.epicAuthoring,
    }));
}

/** GET /api/repo-bootstrap's view: the state, what still holds the drain, whether bootstrap is
 *  suggested, and the proposed next step. `missing` ignores the override, so the operator still
 *  sees what an override skips. */
export async function buildRepoBootstrapView(
  store: ViewStore,
  dir: string,
  mustHaves: readonly string[],
) {
  const b = store.getRepoBootstrap(dir);
  const missing = bootstrapMissing({ ...b, overrideAt: null }, mustHaves) ?? [];
  const suggested = b.state === "off" && !(await hasProjectManifest(dir));
  return { ...b, missing, suggested, next: bootstrapNextStep(b, liveSessions(store, dir)) };
}

type PhaseStore = Pick<SessionStore, "getRepoBootstrap" | "setRepoBootstrap">;

/** An epic draft materialized in `repoPath`: a repo in active bootstrap at P4 moves to P5 (the
 *  exit check). Returns whether the phase moved. */
export function advanceAfterEpicApproved(store: PhaseStore, repoPath: string): boolean {
  const b = store.getRepoBootstrap(repoPath);
  if (b.state !== "active" || b.phase !== 4) return false;
  store.setRepoBootstrap(repoPath, { state: "active", phase: BOOTSTRAP_LAST_PHASE });
  console.log(`[bootstrap] phase 4 → 5 repo=${repoPath} (epic materialized)`);
  return true;
}

type ReconcileStore = PhaseStore &
  Pick<
    SessionStore,
    "listActiveRepoBootstraps" | "bootstrapSessionMergedSince" | "epicDraftApprovedSince"
  >;

/** One forward step from persisted facts newer than `since`; null when no fact moves it. */
function reconcileStep(
  store: ReconcileStore,
  repoPath: string,
  phase: number,
  since: number,
): number | null {
  if (phase <= 2 && store.bootstrapSessionMergedSince(repoPath, 1, since)) return 3;
  if (phase === 3 && store.bootstrapSessionMergedSince(repoPath, 3, since)) return 4;
  if (phase === 4 && store.epicDraftApprovedSince(repoPath, since)) return BOOTSTRAP_LAST_PHASE;
  return null;
}

/**
 * Boot reconcile: heal every advance a restart lost. Facts are counted from the CURRENT phase's
 * start (`phaseAt`) — kept for the whole chain, since a later fact happened after the earlier one —
 * so a re-activated repo never advances on an older run. Returns the repos that moved.
 */
export function reconcileBootstrapPhases(
  store: ReconcileStore,
): { repoPath: string; from: number; to: number }[] {
  const moved: { repoPath: string; from: number; to: number }[] = [];
  for (const { repoPath, phase, phaseAt } of store.listActiveRepoBootstraps()) {
    let to = phase;
    for (let next = reconcileStep(store, repoPath, to, phaseAt); next != null;) {
      to = next;
      next = reconcileStep(store, repoPath, to, phaseAt);
    }
    if (to === phase) continue;
    store.setRepoBootstrap(repoPath, { state: "active", phase: to });
    console.log(`[bootstrap] reconcile phase ${phase} → ${to} repo=${repoPath}`);
    moved.push({ repoPath, from: phase, to });
  }
  return moved;
}
