import { access } from "node:fs/promises";
import { join } from "node:path";
import type { ForgeRun } from "./forge/types";

/**
 * Project-bootstrap mode (#3105, epic #3114): a repo in `active` bootstrap holds its drain
 * (`bootstrap_incomplete`) until phases P1–P4 are complete and the must-haves are green, unless
 * the operator explicitly overrides the hold. `off` = no row (the default for every repo).
 *
 * Phases: P1 stack + scaffold-shaping decisions → P2 scaffold/guardrails/CI on main → P3 gap
 * sweep → P4 backlog against the real scaffold → P5 drain released.
 */
export type BootstrapState = "off" | "active" | "done";

export const BOOTSTRAP_LAST_PHASE = 5;

export interface RepoBootstrap {
  state: BootstrapState;
  /** The CURRENT phase, 1–5; every phase below it is complete (5 ⇒ P1–P4 complete). */
  phase: number;
  /** When the operator overrode the drain hold; null when no override is in force. */
  overrideAt: number | null;
  /** #3411: when a bootstrap session's merge was seen whose phase advance waits for green CI on
   *  the default branch; null when no advance is held. */
  ciPendingAt: number | null;
}

export const BOOTSTRAP_OFF: RepoBootstrap = {
  state: "off",
  phase: 1,
  overrideAt: null,
  ciPendingAt: null,
};

export function isBootstrapPhase(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= 1 && (n as number) <= BOOTSTRAP_LAST_PHASE;
}

/** The must-have placeholder while a repo's greenfield readiness (#3107) has not been scanned yet:
 *  the gate fails closed until the first scan lands. The red must-haves themselves come from
 *  `GreenfieldService.mustHavesMissing` (src/greenfield.ts). */
export const READINESS_PENDING = "readiness_pending";

/**
 * What still holds the drain: `null` when the repo is not gating (off, done, or overridden),
 * otherwise the incomplete phases (`P<n>`) followed by the red must-haves.
 */
export function bootstrapMissing(b: RepoBootstrap, mustHaves: readonly string[]): string[] | null {
  if (b.state !== "active" || b.overrideAt != null) return null;
  const phases: string[] = [];
  for (let p = b.phase; p < BOOTSTRAP_LAST_PHASE; p++) phases.push(`P${p}`);
  return [...phases, ...mustHaves];
}

/** The exit predicate: an active repo with P1–P4 complete and every must-have green is done. */
export function bootstrapExitReached(b: RepoBootstrap, mustHaves: readonly string[]): boolean {
  return b.state === "active" && b.phase === BOOTSTRAP_LAST_PHASE && mustHaves.length === 0;
}

/** The phase a bootstrap SESSION runs (#3110): P1+P2 (one PR) until the repo reaches P3, then the
 *  P3 gap sweep. Picked at create from the repo's state, so the session follows the repo. */
export type BootstrapSessionPhase = 1 | 3;

export function bootstrapSessionPhase(b: RepoBootstrap): BootstrapSessionPhase {
  return b.state === "active" && b.phase >= 3 ? 3 : 1;
}

/** The repo phase after a bootstrap session's PR merged: P1+P2 → 3, P3 → 4. Null when the repo is
 *  not active or already at/after that phase — a merge never moves the phase backwards. */
export function phaseAfterBootstrapMerge(
  b: RepoBootstrap,
  sessionPhase: BootstrapSessionPhase,
): number | null {
  if (b.state !== "active") return null;
  const next = sessionPhase === 1 ? 3 : 4;
  return next > b.phase ? next : null;
}

/** The phase a held advance (#3411) lands on: P1+P2 → 3, P3 → 4; null past P3. */
export function heldAdvanceTarget(b: RepoBootstrap): number | null {
  if (b.phase <= 2) return 3;
  return b.phase === 3 ? 4 : null;
}

/** Slack between the merge Shepherd observed (late: poller lag, restart) and the forge creating
 *  the post-merge run. */
const POST_MERGE_SKEW_MS = 30 * 60_000;
const OK_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

export type PostMergeCi = "green" | "waiting" | "failed";

/**
 * Default-branch CI after a bootstrap merge at `since` (#3411): judged on the runs of the newest
 * head that has runs since the merge — "does main's current head build". No run yet → waiting; any
 * finished run that didn't pass (incl. a 0-job "workflow file issue" run) → failed.
 */
export function postMergeCi(runs: readonly ForgeRun[], since: number): PostMergeCi {
  const recent = runs.filter((r) => r.createdAt >= since - POST_MERGE_SKEW_MS);
  if (recent.length === 0) return "waiting";
  const newest = recent.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  const head = recent.filter((r) => r.headSha === newest.headSha);
  const done = head.filter((r) => r.status === "completed");
  if (done.some((r) => !OK_CONCLUSIONS.has(r.conclusion ?? ""))) return "failed";
  return done.length === head.length ? "green" : "waiting";
}

/** True when the repo root carries a manifest of a supported ecosystem (package.json /
 *  Cargo.toml). A repo without one is SUGGESTED for bootstrap mode, never switched on. Async so
 *  it never blocks the server loop. */
export async function hasProjectManifest(dir: string): Promise<boolean> {
  for (const f of ["package.json", "Cargo.toml"]) {
    try {
      await access(join(dir, f));
      return true;
    } catch {
      /* absent — try the next manifest */
    }
  }
  return false;
}
