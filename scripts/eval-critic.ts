// Live-model eval for the PR-critic prompt (issue #2156), on the shared harness in
// `scripts/eval-core.ts`. See `docs/eval-harness.md` for methodology, baselines and the floor.
//
// This is the one eval that genuinely needs the tool loop. `reviewPrompt` tells the reviewer the
// branch is checked out and orders `git diff <base>...HEAD` plus tree greps, so the harness
// declares `Bash`/`Read`/`Grep` and answers them from the fixture's `{ diff, files }` map. The
// production prompt is imported unchanged, and no model-authored shell is ever executed.
//
// TWO WRITES, not one: `scopeAndOutputTail` orders `.shepherd-review.md` FIRST and
// `.shepherd-review.json` LAST — "the JSON file is the completion signal" — and tells the model to
// omit `body` from the JSON once the markdown exists. So `verdictFile` is `VERDICT_FILE`: the
// markdown write is acknowledged and the loop continues, terminating only on the JSON. Stopping at
// the first write would capture prose and score every fixture as a parse failure.
//
// Scoring reads the RAW findings the prompt produced. Production additionally applies the
// deterministic `scopeFindings` backstop (out-of-diff findings dropped server-side), which is
// unit-tested separately — leaving it out here keeps a prompt regression visible instead of masked.

import {
  VERDICT_FILE,
  normalizeDecision,
  normalizeFindings,
  prReviewPrompt,
  reviewPrompt,
} from "../src/critic-core";
import { CRITIC_FIXTURES, type CriticFixture } from "./eval-fixtures/critic";
import { respondFromEnv } from "./eval-fixtures/env";
import {
  AGENT_SYSTEM_PROMPT,
  READONLY_TOOLS,
  WRITE_TOOL,
  main,
  type EvalSpec,
  type Score,
} from "./eval-core";

/** `claude-sonnet-5` is the API snapshot standing in for the operator's critic role model
 *  (`criticModel`, "default" ⇒ the operator default). Overridable via `--model`. */
const DEFAULT_MODEL = "claude-sonnet-5";
/** The critic writes a FULL markdown review as a tool input before its verdict, and both pass
 *  through this budget. Set high deliberately: a run truncated at `max_tokens` mid-`tool_use` hands
 *  back a partial argument object, which scores as a parse failure and quietly pollutes the
 *  baseline with a mechanical miss. `max_tokens` is a cap, not a reservation — output is billed on
 *  what is actually generated, so the headroom is free. */
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
  "changes_requested",
  "commented",
  "changes_requested:bad-findings",
  "commented:bad-findings",
  "no-verdict",
];

export function scoreCritic(fixture: CriticFixture, raw: Record<string, unknown> | null): Score {
  if (raw === null) return { label: "no-verdict", correct: false };
  // The REAL production normalizers: `normalizeDecision` maps the prompt's two literals onto the
  // stored `ReviewDecision` (and rejects anything else), `normalizeFindings` coerces the array.
  const decision = normalizeDecision(raw.decision);
  if (decision === null) return { label: "no-verdict", correct: false };

  const findings = normalizeFindings(raw.findings);
  // The prompt's hard contract: `request-changes` requires at least one finding; `comment` with a
  // populated findings array contradicts the routing rules (blocking items are what findings ARE).
  const contractOk = decision === "changes_requested" ? findings.length > 0 : findings.length === 0;
  const routingOk =
    (fixture.findingsMustMatch ?? []).every((re) => findings.some((f) => re.test(f))) &&
    (fixture.findingsMustNotMatch ?? []).every((re) => !findings.some((f) => re.test(f)));

  const findingsOk = contractOk && routingOk;
  return {
    label: findingsOk ? decision : `${decision}:bad-findings`,
    correct: decision === fixture.expectedDecision && findingsOk,
  };
}

/** Build the prompt with the REAL builder for this fixture's critic variant. */
export function buildCriticPrompt(fixture: CriticFixture): string {
  if (fixture.kind === "pr") {
    return prReviewPrompt(
      fixture.diffBase,
      fixture.prTitle ?? "",
      fixture.prBody ?? "",
      null,
      null,
    );
  }
  return reviewPrompt(
    fixture.diffBase,
    fixture.task ?? "",
    fixture.priorFindings ?? [],
    fixture.authorNotes ?? [],
    fixture.issueBody ?? null,
    null,
    {
      plan: fixture.plan ?? null,
      smellLens: fixture.smellLens,
      round: fixture.round,
      cap: fixture.cap,
    },
  );
}

export const SPEC: EvalSpec<CriticFixture> = {
  name: "critic",
  defaultModel: DEFAULT_MODEL,
  defaultTrials: DEFAULT_TRIALS,
  defaultTemperature: DEFAULT_TEMPERATURE,
  floor: GATING_ACCURACY_FLOOR,
  observational: OBSERVATIONAL,
  fixtures: CRITIC_FIXTURES,
  labels: LABELS,
  tools: [WRITE_TOOL, ...READONLY_TOOLS],
  // Without this the model answers a review prompt in prose and never writes a verdict — see
  // AGENT_SYSTEM_PROMPT for the live evidence. Mode-setting only; it says nothing about judgement.
  system: AGENT_SYSTEM_PROMPT,
  // The completion signal, not the first write — see the two-writes note above.
  verdictFile: VERDICT_FILE,
  // Budget: the diff read, a handful of greps/reads, then BOTH writes. Generous enough that a
  // thorough review is not truncated, bounded enough that a confused run cannot spend indefinitely.
  maxTurns: 18,
  maxTokens: MAX_TOKENS,
  expectedLabel: (fixture) => fixture.expectedDecision,
  buildPrompt: buildCriticPrompt,
  respond: (fixture, name, input) => respondFromEnv(fixture.env, name, input),
  score: scoreCritic,
};

if (import.meta.main) {
  await main(SPEC);
}
