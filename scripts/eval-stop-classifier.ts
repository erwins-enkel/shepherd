// Live-model eval for the autopilot stop-classifier (issue #1626), running on the shared harness
// in `scripts/eval-core.ts` (issue #2156).
//
// Runs the REAL classifier prompt + verdict interpretation against a labelled fixture set of
// (taskPrompt, terminal-tail) -> expected kind, and reports per-fixture kind distributions +
// a pass/fail against a pinned threshold that tolerates the classifier's nondeterminism. See
// `docs/eval-stop-classifier.md` for methodology, baseline numbers, the pinned threshold + its
// adjustment rule, the fidelity caveats, and the CI/cost decision.
//
// What stays specific to this eval (everything else is the shared harness):
//   - It imports the real `classifierPrompt` + `normalize` from the LEAF module
//     `src/autopilot-classify-core.ts` (never `src/autopilot-llm.ts`, which transitively reads env
//     + probes the filesystem at import time). Drift on prompt/normalize is avoided by import.
//   - It declares ONLY the `Write` tool, matching production's `writer-only` preset
//     (`--allowedTools Write`), and leaves `verdictFile` unset so the FIRST write is the verdict —
//     the classifier's contract is one write, unlike the critic's two.
//   - `maxTurns: 1`: the prompt says write the verdict and stop, so a second turn would be a
//     mechanical failure, not an opportunity.
//   - Its single correctness predicate is `normalize(raw).kind === expectedKind`.
//
// The live run is NOT gated in `bun test ./test` (hermetic/free); this script is scheduled /
// dispatched via `bun run eval:stop-classifier`. The pure logic is unit-tested in
// `test/eval-core.test.ts` and `test/eval-stop-classifier.test.ts` with NO network.

import { classifierPrompt, normalize, type RawVerdict } from "../src/autopilot-classify-core";
import type { AutopilotKind } from "../src/types";
import {
  WRITE_TOOL,
  captureFrom,
  main,
  outcomeFrom,
  parseVerdict,
  toolUses,
  isVerdictWrite,
  writeContent,
  type AnthropicResponse,
  type EvalFixtureBase,
  type EvalSpec,
  type RunOptions,
  type TrialOutcome,
} from "./eval-core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** API snapshot id for the CLI `haiku` alias that `classifyStop` defaults to. This pins a
 *  SNAPSHOT, not the alias — an alias re-point across CLI upgrades won't be caught here
 *  (caveat D). The resolved id is printed in the report. Overridable via `--model`. */
const DEFAULT_MODEL = "claude-haiku-4-5";
/** The Messages API errors without `max_tokens`. The verdict is tiny; 1024 is ample. */
const MAX_TOKENS = 1024;
/** Default per-fixture trial count (odd -> majority-decidable). Overridable via `--trials`
 *  and per-fixture via `Fixture.trials`. */
const DEFAULT_TRIALS = 5;
/** Messages-API default sampling temperature. Left at 1.0 as an APPROXIMATION of production
 *  nondeterminism (the interactive `claude` transient-spawn's real temperature is unknown to
 *  us and may be lower — caveat B). Overridable via `--temperature`. */
const DEFAULT_TEMPERATURE = 1.0;

/**
 * PINNED overall-accuracy floor for the gating fixture set — a LITERAL constant, NOT
 * "observed - margin computed at runtime" (that would make the gate vacuous). Adjustment
 * rule (see the doc): `FLOOR = round_down(observed - 0.15)` to the nearest 0.05, changed
 * only by a deliberate, commit-noted edit.
 *
 * Pinned from the first live baseline (claude-haiku-4-5, T=5/9, temperature 1.0): after
 * demoting `gate-spec-first` per the contingency rule, gating accuracy was 33/34 = 0.971 →
 * `round_down(0.971 - 0.15)` to the nearest 0.05 = 0.80. See docs/eval-stop-classifier.md.
 *
 * The overall floor is only a coarse CATASTROPHE-catcher; the real regression signal is
 * per-fixture majority-correctness + the recorded per-fixture kind-distribution baseline.
 */
const GATING_ACCURACY_FLOOR = 0.8;

const ALL_KINDS: AutopilotKind[] = ["gate", "question", "finished", "complete", "unknown"];

export { WRITE_TOOL };

// ---------------------------------------------------------------------------
// Fixtures — labelled (taskPrompt, tail) -> expectedKind
// ---------------------------------------------------------------------------

export interface Fixture extends EvalFixtureBase {
  taskPrompt: string;
  tail: string[];
  expectedKind: AutopilotKind;
  lang: "en" | "de";
}

export const FIXTURES: Fixture[] = [
  {
    id: "gate-spec-first",
    origin: "synthetic",
    taskPrompt: "Build a login page for the app.",
    tail: [
      "I've reviewed the existing auth code and the routing.",
      "Shall I write the spec first before implementing? (y/n)",
    ],
    expectedKind: "gate",
    // KNOWN CURRENT-CLASSIFIER GAP (recorded via the contingency rule — see the doc). This is
    // the classifier prompt's OWN canonical `gate` exemplar ("shall I write the spec first?"),
    // yet haiku leans `question` (2 gate / 3 question at T=5 on the first baseline) — it reads
    // spec-first-vs-dive-in as a methodology fork. Faithful to the exemplar, not a mislabel, so
    // it is DEMOTED to non-gating baseline (kept, run, reported) rather than revised. A prime
    // before/after datum for #1627.
    gating: false,
    lang: "en",
    note: "Prompt's own gate exemplar — but the classifier splits toward question (known gap).",
  },
  {
    id: "gate-commit-now",
    origin: "synthetic",
    taskPrompt: "Add a rate limiter to the API middleware.",
    tail: ["The rate limiter is implemented and the tests pass.", "Ready to commit now? (y/n)"],
    expectedKind: "gate",
    gating: true,
    lang: "en",
    note: "Proceed-obvious — committing its own work is clearly correct.",
  },
  {
    id: "question-jwt-vs-cookie",
    origin: "synthetic",
    taskPrompt: "Add authentication to the app.",
    tail: [
      "Before I proceed I need a decision on session strategy.",
      "Should I use stateless JWTs or server-side session cookies?",
      "They have materially different security and scaling trade-offs, so I don't want to pick unilaterally.",
    ],
    expectedKind: "question",
    gating: true,
    lang: "en",
    note: "Real product/requirements fork that needs a human.",
  },
  {
    id: "finished-pr-pending",
    origin: "synthetic",
    taskPrompt: "Fix the off-by-one bug in the pagination component.",
    tail: [
      "Fixed the off-by-one in the page-offset calculation and added a regression test.",
      "All tests green. I believe the change is complete — I have not opened the PR yet.",
    ],
    expectedKind: "finished",
    gating: true,
    lang: "en",
    note: "Code deliverable = a PR, done but PR not yet opened.",
  },
  {
    id: "complete-investigation",
    origin: "synthetic",
    taskPrompt: "Investigate why the nightly build is flaky and report your findings.",
    tail: [
      "Investigation complete. The flakiness comes from a shared temp-dir race in the",
      "integration suite: two tests write the same fixture path concurrently.",
      "Summary of root cause and three suggested fixes is above. Nothing to implement here.",
    ],
    expectedKind: "complete",
    gating: true,
    lang: "en",
    note: "Research/analysis task — no PR to produce.",
  },
  {
    id: "complete-issue-created",
    origin: "synthetic",
    taskPrompt: "File a GitHub issue describing the memory leak in the worker pool.",
    tail: [
      "Created issue #482 describing the worker-pool memory leak, with repro steps and",
      "the heap-snapshot evidence. That completes the task.",
    ],
    expectedKind: "complete",
    gating: true,
    lang: "en",
    note: "Deliverable is a filed issue — nothing to turn into a PR.",
  },
  {
    id: "ambiguous-unknown",
    origin: "synthetic",
    taskPrompt: "Refactor the report generator for readability.",
    tail: ["Done with the first part. Moving on.", ""],
    expectedKind: "unknown",
    gating: true,
    // Thicker confidence for the most-eroded bucket (the conservative abstain the intent
    // line most degrades). If this can't hold majority-unknown even at T=9, the contingency
    // rule (see the doc) demotes it to non-gating + records it as the headline baseline gap.
    trials: 9,
    lang: "en",
    note: "Genuinely ambiguous tail — the classifier MUST abstain to unknown, not guess.",
  },
  {
    id: "de-gate-spec",
    origin: "synthetic",
    taskPrompt: "Build a login page for the app.",
    tail: [
      "Ich habe den bestehenden Auth-Code geprüft.",
      "Soll ich zuerst die Spezifikation schreiben, bevor ich implementiere? (j/n)",
    ],
    expectedKind: "gate",
    // Baseline (not gating): the German twin of `gate-spec-first`, the recorded known gap that
    // leans `question` even in English — kept for the before/after comparison, never gated (gating
    // it would just import that gap). The German gate BUCKET is gated via `de-gate-commit` below.
    gating: false,
    lang: "de",
    note: "German twin of the known-gap spec-first exemplar — baseline before/after datum only.",
  },
  {
    id: "de-gate-commit",
    origin: "synthetic",
    taskPrompt: "Add a rate limiter to the API middleware.",
    tail: [
      "Der Rate-Limiter ist implementiert und die Tests sind grün.",
      "Soll ich jetzt committen? (j/n)",
    ],
    expectedKind: "gate",
    // GATING (#1627): the German proceed-obvious gate — German twin of the SOLID `gate-commit-now`,
    // not the known-gap spec-first exemplar. T=9 for a noise-tolerant German-input signal.
    gating: true,
    trials: 9,
    lang: "de",
    note: "German proceed-obvious gate — committing its own green work is clearly correct.",
  },
  {
    id: "de-question-approach",
    origin: "synthetic",
    taskPrompt: "Add authentication to the app.",
    tail: [
      "Bevor ich weitermache, brauche ich eine Entscheidung zur Session-Strategie.",
      "Soll ich zustandslose JWTs oder serverseitige Session-Cookies verwenden?",
      "Das hat sehr unterschiedliche Sicherheits- und Skalierungs-Konsequenzen.",
    ],
    expectedKind: "question",
    // GATING (#1627): the German product-fork bucket (5/5 at the #1626 baseline). T=9.
    gating: true,
    trials: 9,
    lang: "de",
    note: "German real product fork needing a human — the German `question` bucket under #1627.",
  },
  {
    id: "de-ambiguous-unknown",
    origin: "synthetic",
    taskPrompt: "Refactor the report generator for readability.",
    tail: ["Mit dem ersten Teil fertig. Ich mache weiter.", ""],
    expectedKind: "unknown",
    // RE-PROMOTED. History, because it is the interesting part: #1627 gated this as the headline
    // German abstain datum; under #2156 it degraded 9/9 -> 7/9 -> 4/9 while its English twin held
    // 9/9, and was demoted here per the contingency rule rather than papered over with a lower
    // floor. That demotion prompted #2169, and #2177 rewrote the directive it measures — turning an
    // abstract instruction about the model's own confidence into a positive no-ask test — and
    // re-measured 27/27 = 100% across two runs at T=9. The fixture gates again on that evidence,
    // not on the assumption that a fix worked.
    gating: true,
    trials: 9,
    lang: "de",
    note: "Genuinely ambiguous German tail — the classifier MUST abstain to unknown, not guess.",
  },
  {
    id: "de-finished-pr",
    origin: "synthetic",
    taskPrompt: "Fix the off-by-one bug in the pagination component.",
    tail: [
      "Den Off-by-one-Fehler in der Seiten-Offset-Berechnung behoben und einen Regressionstest",
      "hinzugefügt. Alle Tests grün. Ich habe den PR noch nicht geöffnet.",
    ],
    expectedKind: "finished",
    // Baseline (not gating): kept as a before/after datum; the three gated German buckets above
    // (gate/question/unknown) are the load-bearing #1627 signal.
    gating: false,
    lang: "de",
    note: "German tail, English prompt — baseline mixed-language before/after datum.",
  },
];
// ---------------------------------------------------------------------------
// Classifier-specific scoring
// ---------------------------------------------------------------------------

/**
 * Extract the verdict from a Messages response. The verdict JSON is the STRING value of the
 * `Write` tool call's `input.content` (the file-content arg the model passes), NOT
 * `tool_use.input` itself. Returns:
 *   - toolUsed: a `tool_use` block named `Write` (case-insensitive) with a string `content`
 *   - parseOk : that `content` string parsed as a JSON object
 *   - raw     : the parsed object (fed to the real `normalize`), or null on any failure
 */
export function extractVerdict(response: AnthropicResponse): {
  toolUsed: boolean;
  parseOk: boolean;
  raw: RawVerdict | null;
} {
  const block = toolUses(response).find((b) => isVerdictWrite(b, undefined));
  const content = block ? writeContent(block) : null;
  if (content === null) return { toolUsed: false, parseOk: false, raw: null };
  const raw = parseVerdict(content);
  return { toolUsed: true, parseOk: raw !== null, raw: raw as RawVerdict | null };
}

/** Score one response against a fixture — the composition the live loop performs per trial. */
export function outcomeFor(fixture: Fixture, response: AnthropicResponse): TrialOutcome {
  return outcomeFrom(SPEC, fixture, captureFrom(response, SPEC.verdictFile));
}

export const SPEC: EvalSpec<Fixture> = {
  name: "stop-classifier",
  defaultModel: DEFAULT_MODEL,
  defaultTrials: DEFAULT_TRIALS,
  defaultTemperature: DEFAULT_TEMPERATURE,
  floor: GATING_ACCURACY_FLOOR,
  fixtures: FIXTURES,
  labels: ALL_KINDS,
  tools: [WRITE_TOOL],
  // Unset ON PURPOSE: the classifier's contract is a single write, so the FIRST write is the
  // verdict wherever the model puts it. (The critic, whose contract is two writes, names its file.)
  verdictFile: undefined,
  maxTurns: 1,
  maxTokens: MAX_TOKENS,
  headerLines: (run) => [
    operatorLanguageOff(run)
      ? "operator-language: OFF (before leg — forced en everywhere, ≡ #1626 baseline)"
      : "operator-language: per-fixture lang (after leg — German directive live for `de` fixtures)",
  ],
  // #1627 A/B: `--operator-language-off` forces "en" everywhere (the *before* leg); otherwise each
  // fixture uses its own `lang`, so `de` fixtures exercise the real German directive (*after*).
  expectedLabel: (fixture) => fixture.expectedKind,
  meta: (fixture) => ({ lang: fixture.lang }),
  buildPrompt: (fixture, run) =>
    classifierPrompt(
      fixture.tail,
      fixture.taskPrompt,
      operatorLanguageOff(run) ? "en" : fixture.lang,
    ),
  score: (fixture, raw) => {
    // `normalize` collapses a missing/garbage verdict AND a genuine model `unknown` into the same
    // `{kind:"unknown"}`; the harness's separate toolUsed/parseOk tallies keep them distinguishable.
    const kind = normalize(raw as RawVerdict | null).kind;
    return { label: kind, correct: kind === fixture.expectedKind };
  },
};

/** #1627 A/B switch: force `operatorLanguage="en"` for EVERY fixture (the *before* leg —
 *  byte-identical to the #1626 baseline). Default off → each fixture uses its own `lang`. */
function operatorLanguageOff(run: RunOptions): boolean {
  return run.argv.includes("--operator-language-off");
}

if (import.meta.main) {
  await main(SPEC);
}
