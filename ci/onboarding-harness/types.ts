import type { DiagnosticState } from "../../src/types";

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
  /** Which apply path to use when the scenario is green-able. "structured" ⇒ a
   *  verbatim REMEDIATIONS command (LLM-free, gate-eligible); "prose" ⇒ the agent
   *  interprets the coaching. Ignored when `detectionOnly` is set (no apply runs). */
  coaching: "structured" | "prose";
  /** The defect is DETECTABLE but cannot be auto-remediated to green in a
   *  throw-away instance because the fix needs a human/secret (e.g. `gh auth login`
   *  device-flow, a Tailscale tailnet login + `serve`). Such scenarios verify
   *  detection only — no apply is attempted, they are excluded from the green
   *  tally and from the release gate, and the gap report classes them DETECTION-ONLY.
   *  An honest "onboarding still needs the user here" finding, not a failure. */
  detectionOnly?: boolean;
  /** Safety net: the agent apply path runs `claude` INSIDE the instance, so a
   *  scenario that removes claude can't use it. With verbatim-first dispatch this
   *  rarely triggers (claude-missing has a verbatim reinstall), but a scenario with
   *  no verbatim fix AND no claude falls back to detection-only rather than failing. */
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
  /** Whether this scenario is part of the deterministic RELEASE GATE — i.e.
   *  `coaching: "structured"` AND not `detectionOnly`, the same subset
   *  `onboarding-gate.sh` runs. Only these drive the gate verdict (commit status +
   *  rolling issue); prose/agent + detection-only scenarios stay in the report as
   *  information and never block a release. */
  gateEligible: boolean;
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
