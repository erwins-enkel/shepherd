/**
 * Bootstrap phase sequencer (#3112, epic #3114): leads an active-bootstrap repo P1+P2 → P3 → P4
 * → exit. The phase advances on a bootstrap session's merge (src/greenfield.ts → onMerged) and on
 * the P4 epic's materialization ({@link advanceAfterEpicApproved}); each advance only PROPOSES the
 * next attended session ({@link bootstrapNextStep}) — nothing is spawned without the operator.
 * A session merge's advance is held until the default branch's CI is green (#3411, resolved by
 * `GreenfieldService`).
 *
 * Restart-safe: the phase lives in `repo_bootstrap`, and {@link reconcileBootstrapPhases} re-derives
 * any advance (or held advance) a crash lost from persisted facts (merged bootstrap sessions,
 * approved epic drafts) newer than the phase's start. It never moves a phase backwards.
 */
import {
  BOOTSTRAP_LAST_PHASE,
  bootstrapMissing,
  hasProjectManifest,
  type BootstrapSessionPhase,
  type PostMergeCi,
  type RepoBootstrap,
} from "./bootstrap";
import type { GreenfieldService } from "./greenfield";
import type { SessionStore } from "./store";
import type { Session } from "./types";

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
 *  suggested, the proposed next step and the CI verdict of a held advance (#3411). `missing`
 *  ignores the override, so the operator still sees what an override skips. */
export async function buildRepoBootstrapView(
  store: ViewStore,
  dir: string,
  mustHaves: readonly string[],
  ciHold: Exclude<PostMergeCi, "green"> | null = null,
) {
  const b = store.getRepoBootstrap(dir);
  const missing = bootstrapMissing({ ...b, overrideAt: null }, mustHaves) ?? [];
  const suggested = b.state === "off" && !(await hasProjectManifest(dir));
  const next = bootstrapNextStep(b, liveSessions(store, dir));
  return { ...b, missing, suggested, next, ciHold };
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
    | "listActiveRepoBootstraps"
    | "bootstrapSessionMergedAt"
    | "epicDraftApprovedAt"
    | "setBootstrapCiPending"
  >;

/** A held session-merge advance (#3411) or an epic approval's advance. */
type ReconcileFact =
  { kind: "hold"; at: number; sessionId: string } | { kind: "advance"; phase: number; at: number };

/** The first persisted fact at or after `since` that moves `phase`; null when none does. */
function reconcileStep(
  store: ReconcileStore,
  repoPath: string,
  phase: number,
  since: number,
): ReconcileFact | null {
  if (phase <= 3) {
    const merged = store.bootstrapSessionMergedAt(repoPath, phase <= 2 ? 1 : 3, since);
    return merged && { kind: "hold", at: merged.at, sessionId: merged.id };
  }
  const at = phase === 4 ? store.epicDraftApprovedAt(repoPath, since) : null;
  return at == null ? null : { kind: "advance", phase: phase + 1, at };
}

/**
 * Boot reconcile: heal every advance a restart lost. The first step counts facts from the CURRENT
 * phase's start (`phaseAt`), so a re-activated repo never advances on an older run. A session
 * merge never advances here — it re-arms the CI hold (#3411) and stops; the greenfield scan
 * resolves it. Returns the repos that moved, or were held (`to === from`).
 */
export function reconcileBootstrapPhases(
  store: ReconcileStore,
): { repoPath: string; from: number; to: number }[] {
  const moved: { repoPath: string; from: number; to: number }[] = [];
  for (const { repoPath, phase, phaseAt, ciPendingAt } of store.listActiveRepoBootstraps()) {
    if (ciPendingAt != null) continue;
    const fact = reconcileStep(store, repoPath, phase, phaseAt);
    if (!fact) continue;
    if (fact.kind === "hold") {
      store.setBootstrapCiPending(repoPath, fact.at, fact.sessionId);
      console.log(`[bootstrap] reconcile phase ${phase} held for CI repo=${repoPath}`);
      moved.push({ repoPath, from: phase, to: phase });
      continue;
    }
    store.setRepoBootstrap(repoPath, { state: "active", phase: fact.phase });
    console.log(`[bootstrap] reconcile phase ${phase} → ${fact.phase} repo=${repoPath}`);
    moved.push({ repoPath, from: phase, to: fact.phase });
  }
  return moved;
}

type MergeStore = Pick<SessionStore, "getBootstrapPhase">;

/**
 * A session's PR merged: re-scan the repo's greenfield readiness and, for a bootstrap session,
 * hold (or, without a CI signal, make) the phase advance — `GreenfieldService` notifies when it
 * lands. Called from BOTH the poller's merged `session:git` (an attended bootstrap session merged on
 * the forge is never archived as "merged" — the drain reaps only auto sessions, so the operator's
 * later archive records "operator") and the "merged" archive (merge train, local merge).
 * Idempotent: a held or made advance is never re-armed by a second sighting.
 */
export function onBootstrapRepoMerge(
  store: MergeStore,
  greenfield: Pick<GreenfieldService, "onMerged">,
  s: Session,
): void {
  void greenfield
    .onMerged(s.repoPath, s.bootstrap ? store.getBootstrapPhase(s.id) : null, s.id)
    .catch((err) => console.warn("[greenfield]:", err));
}
