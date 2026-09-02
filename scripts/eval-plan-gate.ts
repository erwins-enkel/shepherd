// Live-model eval for the plan-gate reviewer prompt (issue #2156), on the shared harness in
// `scripts/eval-core.ts`. See `docs/eval-harness.md` for methodology, baselines and the floor.
//
// The prompt (`planReviewPrompt` from `src/plan-gate.ts`) carries the plan and task inline and only
// OFFERS read-only codebase inspection, so most fixtures answer zero tool calls. The ones that pin
// a LOCATION-REFERENCES tier (`anchor.ahead === 0`, where an unresolvable reference to committed
// code IS a finding) carry a small file map, answered by the shared fixture environment.
//
// `planReviewPrompt` is imported from the production module, so the eval cannot drift from the
// prompt that ships. The decision mapping below mirrors `PlanGateService`'s private
// `normalizeDecision` — the two literals are the prompt's own output contract, and
// `test/eval-core.test.ts` asserts the rendered prompt still names exactly those two.

import { PLAN_VERDICT_FILE, planReviewPrompt, type RawPlanVerdict } from "../src/plan-gate";
import { PLAN_GATE_FIXTURES, type PlanGateFixture } from "./eval-fixtures/plan-gate";
import { respondFromEnv } from "./eval-fixtures/env";
import {
  AGENT_SYSTEM_PROMPT,
  READONLY_TOOLS,
  WRITE_TOOL,
  main,
  type EvalSpec,
  type Score,
} from "./eval-core";

/** `claude-sonnet-5` is the API snapshot standing in for the operator's plan-reviewer role model
 *  (`reviewerModel`, "default" ⇒ the operator default). Overridable via `--model`. */
const DEFAULT_MODEL = "claude-sonnet-5";
/** The verdict carries a full markdown `body` alongside the findings list, inside the same
 *  `tool_use` argument. Same reasoning as the critic's budget: truncation mid-argument scores as a
 *  parse failure, and unused headroom is free. */
const MAX_TOKENS = 16384;
const DEFAULT_TRIALS = 5;
const DEFAULT_TEMPERATURE = 1.0;

/**
 * PINNED overall-accuracy floor for the gating fixture set — a LITERAL, never "observed − margin"
 * computed at runtime. Adjustment rule: `FLOOR = round_down(observed − 0.15)` to the nearest 0.05,
 * changed only by a deliberate, commit-noted edit. See `docs/eval-harness.md`.
 */
const GATING_ACCURACY_FLOOR = 0.75;

/** OBSERVATIONAL until a measured run exists. No run has yet scored this eval's PROMPT: the first
 *  hit the prose-instead-of-tools mode failure, the second exhausted the turn budget, and the third
 *  could not run at all (workspace usage limit, resets 2026-10-01). The floor above is therefore an
 *  unobserved guess, and gating a PR on a number nobody has measured would be theatre. The fixtures
 *  still run, score and report on every trigger. Flip this to `false` in the same commit that pins
 *  the floor from a real run — see the baselines section of docs/eval-harness.md. */
const OBSERVATIONAL = true;

const LABELS = [
  "approve",
  "request-changes",
  "approve:bad-findings",
  "request-changes:bad-findings",
  "no-verdict",
];

/** The reviewer's two legal decision values, per the prompt's literal output contract. Mirrors
 *  `PlanGateService`'s private `normalizeDecision`; anything else is a malformed verdict. */
export function normalizePlanDecision(d: unknown): "approve" | "request-changes" | null {
  if (d === "approve") return "approve";
  if (d === "request-changes") return "request-changes";
  return null;
}

/** Coerce the reviewer's `findings` to a clean string[] (drops junk, never throws). */
export function planFindings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is string => typeof f === "string")
    .map((f) => f.trim())
    .filter(Boolean);
}

export function scorePlanGate(
  fixture: PlanGateFixture,
  raw: Record<string, unknown> | null,
): Score {
  if (raw === null) return { label: "no-verdict", correct: false };
  const verdict = raw as RawPlanVerdict;
  const decision = normalizePlanDecision(verdict.decision);
  if (decision === null) return { label: "no-verdict", correct: false };

  const findings = planFindings(verdict.findings);
  // The prompt's hard contract, applied to EVERY fixture: approve iff nothing remains in
  // `findings`; otherwise request-changes with at least one. A verdict that breaks this is
  // malformed regardless of which decision the fixture expected.
  const contractOk = decision === "approve" ? findings.length === 0 : findings.length > 0;
  const routingOk =
    (fixture.findingsMustMatch ?? []).every((re) => findings.some((f) => re.test(f))) &&
    (fixture.findingsMustNotMatch ?? []).every((re) => !findings.some((f) => re.test(f)));

  const findingsOk = contractOk && routingOk;
  return {
    label: findingsOk ? decision : `${decision}:bad-findings`,
    correct: decision === fixture.expectedDecision && findingsOk,
  };
}

export const SPEC: EvalSpec<PlanGateFixture> = {
  name: "plan-gate",
  defaultModel: DEFAULT_MODEL,
  defaultTrials: DEFAULT_TRIALS,
  defaultTemperature: DEFAULT_TEMPERATURE,
  floor: GATING_ACCURACY_FLOOR,
  observational: OBSERVATIONAL,
  fixtures: PLAN_GATE_FIXTURES,
  labels: LABELS,
  tools: [WRITE_TOOL, ...READONLY_TOOLS],
  // Without this the model answers a review prompt in prose and never writes a verdict — see
  // AGENT_SYSTEM_PROMPT for the live evidence and for what it does say: tool-driven operation plus
  // disclosure of the harness's turn limit, which production does not have (fidelity caveat F in
  // docs/eval-harness.md). It carries no guidance about what to look for or how to judge it.
  system: AGENT_SYSTEM_PROMPT,
  verdictFile: PLAN_VERDICT_FILE,
  // The prompt invites optional inspection before the single verdict write, so the budget has to
  // admit a few look-around turns without letting a confused run spend indefinitely.
  maxTurns: 14,
  maxTokens: MAX_TOKENS,
  expectedLabel: (fixture) => fixture.expectedDecision,
  buildPrompt: (fixture) =>
    planReviewPrompt(
      fixture.task,
      fixture.plan,
      fixture.priorFindings ?? [],
      fixture.issueBody ?? null,
      fixture.lang,
      fixture.anchor ?? null,
      fixture.staleness ?? null,
      fixture.opts ?? {},
    ),
  respond: (fixture, name, input) => respondFromEnv(fixture.env ?? {}, name, input),
  score: scorePlanGate,
};

if (import.meta.main) {
  await main(SPEC);
}
