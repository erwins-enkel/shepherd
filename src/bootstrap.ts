import { access } from "node:fs/promises";
import { join } from "node:path";

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
}

export const BOOTSTRAP_OFF: RepoBootstrap = { state: "off", phase: 1, overrideAt: null };

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
