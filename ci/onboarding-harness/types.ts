import type { DiagnosticState, DiagnosticsSnapshot } from "../../src/types";

/** A single deliberately-messy environment definition (pure data). */
export interface Scenario {
  /** Stable kebab id; also the Incus instance name suffix. */
  id: string;
  /** Incus image ref, e.g. "images:ubuntu/24.04" or "images:debian/12". */
  image: string;
  /** Provision as a full VM instead of a system container (kernel/arch fidelity). */
  vm?: boolean;
  /** Shell commands run in order (each via `sh -c`) to produce the messy state. */
  seed: string[];
  /** Checks that MUST be flagged at the given state after seeding. */
  expect: ExpectedCheck[];
  /** Which apply path to use. In Phase 1 "structured" falls back to the agent path. */
  coaching: "structured" | "prose";
  /** The agent apply path runs `claude` INSIDE the instance; a scenario that
   *  removes claude (claude-missing) cannot use it. Such scenarios are
   *  detection-only in Phase 1 and switch to the verbatim path in Phase 2. */
  agentIncompatible?: boolean;
}

export interface ExpectedCheck {
  id: string;
  state: DiagnosticState;
}

/** Result of comparing a captured snapshot against a scenario's expectations. */
export interface DetectionResult {
  scenarioId: string;
  /** True when every expected check matched its expected state. */
  detected: boolean;
  /** Expected checks whose actual state diverged (incl. absent from snapshot). */
  misses: Array<{ id: string; want: DiagnosticState; got: DiagnosticState | "absent" }>;
}

/** Full per-scenario outcome the report is built from. */
export interface ScenarioResult {
  scenarioId: string;
  image: string;
  detection: DetectionResult;
  appliedVia: "agent" | "verbatim" | "skipped";
  reachedGreen: boolean;
  /** True when no apply was attempted BY DESIGN (e.g. claude-missing in Phase 1):
   *  the report classifies it DETECTION-ONLY, not an advice gap. */
  detectionOnly?: boolean;
  error?: string;
}

/** One `incus` CLI invocation result. */
export interface IncusExec {
  stdout: string;
  stderr: string;
  code: number;
}

/** Injectable `incus` runner: receives argv (after the `incus` binary), resolves
 *  with captured output. Tests inject a fake; production runs the real binary. */
export type IncusRunner = (args: string[]) => Promise<IncusExec>;

export type { DiagnosticsSnapshot };
