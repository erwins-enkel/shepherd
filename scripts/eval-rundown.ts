// Live-model eval for the rundown prompt (issue #2156), on the shared harness in
// `scripts/eval-core.ts`. See `docs/eval-harness.md` for methodology, baselines and the floor.
//
// The rundown is the most self-contained of the four: `buildRundownPrompt` serializes the whole
// herd state inline and the agent's only job is to write `.shepherd-rundown.json`. So this eval
// declares `Write` only and needs no fixture environment.
//
// Both the prompt and the verdict parser are the REAL ones (`buildRundownPrompt`,
// `parseRundownVerdict` from `src/rundown-core.ts` — a leaf module with no import-time side
// effects), so the eval cannot drift from production on either axis. `parseRundownVerdict` also
// applies production's clamps (caps, label truncation, malformed items dropped), which means the
// eval scores what the UI would actually receive, not the raw model output.

import { RUNDOWN_VERDICT_FILE, buildRundownPrompt, parseRundownVerdict } from "../src/rundown-core";
import type { RundownItem, RundownVerdict } from "../src/types";
import { RUNDOWN_FIXTURES, type RundownFixture } from "./eval-fixtures/rundown";
import { WRITE_TOOL, main, type EvalSpec, type Score } from "./eval-core";

/** `claude-sonnet-5` is the API snapshot for the model the rundown role actually runs on: its
 *  `RoleEnvironment` default is `{ provider: "claude", model: "sonnet" }` (see
 *  `HerdDigestService`). Overridable via `--model`. */
const DEFAULT_MODEL = "claude-sonnet-5";
/** The verdict carries five prose sections; production's own spawn is unconstrained, and the
 *  parser clamps every field, so this only needs to be comfortably above a full verdict. */
const MAX_TOKENS = 4096;
const DEFAULT_TRIALS = 5;
const DEFAULT_TEMPERATURE = 1.0;

/**
 * PINNED overall-accuracy floor for the gating fixture set — a LITERAL, never "observed − margin"
 * computed at runtime (that would make the gate vacuous). Adjustment rule:
 * `FLOOR = round_down(observed − 0.15)` to the nearest 0.05, changed only by a deliberate,
 * commit-noted edit. Pinned from the first live baseline; see `docs/eval-harness.md`.
 */
const GATING_ACCURACY_FLOOR = 0.75;

/** `ok` plus one label per predicate CLASS, so the report's distribution says how a fixture failed
 *  rather than only that it did. */
const LABELS = [
  "ok",
  "miss:not-surfaced",
  "miss:leaked",
  "miss:silent",
  "miss:manufactured",
  "miss:epic-echo",
  "miss:empty-section",
  "no-verdict",
];

/** Every item the verdict names, across all four item arrays. */
function allItems(v: RundownVerdict): RundownItem[] {
  return [...v.decisions, ...v.ciRework, ...v.focusNext];
}

/** Session ids the verdict puts in the "needs a human now" buckets. */
function surfacedIds(v: RundownVerdict): Set<string> {
  return new Set(
    [...v.decisions, ...v.ciRework]
      .map((i) => i.sessionId)
      .filter((id): id is string => typeof id === "string"),
  );
}

/**
 * Score one verdict against the fixture's predicates. Returns the FIRST failed predicate class as
 * the label, checked in a fixed order so a given failure always reports the same way.
 */
export function scoreRundown(fixture: RundownFixture, raw: Record<string, unknown> | null): Score {
  if (raw === null) return { label: "no-verdict", correct: false };
  // Re-serialize and run production's own parser, so the eval scores the clamped verdict the UI
  // would receive rather than the raw object.
  const verdict = parseRundownVerdict(JSON.stringify(raw));
  if (verdict === null) return { label: "no-verdict", correct: false };

  const e = fixture.expect;
  const surfaced = surfacedIds(verdict);
  const items = allItems(verdict);
  const namedAnywhere = new Set(
    items.map((i) => i.sessionId).filter((id): id is string => typeof id === "string"),
  );

  for (const id of e.mustSurface ?? []) {
    if (!surfaced.has(id)) return { label: "miss:not-surfaced", correct: false };
  }
  for (const id of e.mustNotSurface ?? []) {
    if (namedAnywhere.has(id)) return { label: "miss:leaked", correct: false };
  }
  if (e.mustSurfaceSomething === true && verdict.decisions.length + verdict.ciRework.length === 0) {
    return { label: "miss:silent", correct: false };
  }
  for (const section of e.empty ?? []) {
    if (verdict[section].length > 0) return { label: "miss:manufactured", correct: false };
  }
  for (const parent of e.noEpicEcho ?? []) {
    // The prompt renders epics as `#<parent>`; an echo reproduces that reference in a label.
    const needle = `#${parent}`;
    if (items.some((i) => i.label.includes(needle))) {
      return { label: "miss:epic-echo", correct: false };
    }
  }
  for (const section of e.nonEmpty ?? []) {
    const value = verdict[section];
    const filled = typeof value === "string" ? value.trim() !== "" : value.length > 0;
    if (!filled) return { label: "miss:empty-section", correct: false };
  }
  return { label: "ok", correct: true };
}

export const SPEC: EvalSpec<RundownFixture> = {
  name: "rundown",
  defaultModel: DEFAULT_MODEL,
  defaultTrials: DEFAULT_TRIALS,
  defaultTemperature: DEFAULT_TEMPERATURE,
  floor: GATING_ACCURACY_FLOOR,
  fixtures: RUNDOWN_FIXTURES,
  labels: LABELS,
  tools: [WRITE_TOOL],
  verdictFile: RUNDOWN_VERDICT_FILE,
  // The prompt's contract is a single write with no inspection step. A text-only reply ends the
  // loop on its own, so the second turn buys exactly one thing: a first write to the WRONG path is
  // acknowledged and the model gets a chance to write the verdict file it was actually asked for.
  maxTurns: 2,
  maxTokens: MAX_TOKENS,
  buildPrompt: (fixture) => buildRundownPrompt(fixture.state, fixture.lang),
  score: scoreRundown,
};

if (import.meta.main) {
  await main(SPEC);
}
