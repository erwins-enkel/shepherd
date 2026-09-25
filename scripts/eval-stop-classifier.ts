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
import { jevBackendSpec, type JevChoiceAnswer, type JevChoiceQuestion } from "./eval-jev";

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
    // T=9, twin parity with `de-gate-commit`: measured p(gate)≈0.76 over the last 16 T=5 runs (rest
    // `finished`), so T=5 lost majority ~9% of runs (2026-09-25: gate:2 finished:3). T=9 ≈ 3%.
    trials: 9,
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
    // GATING (#1627): the German proceed-obvious gate — German twin of `gate-commit-now`,
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
    //
    // That 27/27 predated the `unrecognised` tally, so a German-TRANSLATED `kind` would have scored
    // as a correct abstain on this very fixture (see `SPEC.score`). #2368 re-ran the German leg
    // under the fixed scorer: 27/27 unknown again, pooled over three T=9 runs, `unrecognised` 0.
    // The gating promotion rests on a measurement that could have failed.
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

// ---------------------------------------------------------------------------
// JEV backend (`--backend jev`) — the go/no-go from docs/research/jev-system-one-models.md
// ---------------------------------------------------------------------------

/** The `--backend` value this leg registers under. */
const JEV_BACKEND = "jev";

/** Pinned SNAPSHOT, never the `jev-latest` alias: under an alias a vendor re-point would land as a
 *  silent accuracy change in a re-run and read as a prompt regression. */
const JEV_MODEL = "jev-1.13.0";

/** The one question the classifier is: pick one of five kinds. */
const JEV_QUESTION_ID = "kind";

/**
 * TWO FRAMINGS, because which one to ship is an empirical question and this eval exists to answer
 * empirical questions.
 *
 *   VERBATIM (default) — `state` is the REAL production prompt, `criteria` are bare option names.
 *     JEV reads the same words the Claude classifier reads, so the two legs differ only in the
 *     model. Inherits the harness's drift-prevented-by-import property for free: the prompt comes
 *     from `src/autopilot-classify-core.ts` and cannot go stale.
 *
 *   AUTHORED (`--jev-authored`) — `state` is structured data and `criteria` carry the per-kind
 *     descriptions. This is the shape a `Judge` seam would plausibly ship, and it is the one a
 *     reasonable person would expect to win.
 *
 * On a 16-call pre-implementation probe it did not win: verbatim 8/8, authored 6/8, and authored
 * missed in the dangerous direction — it called the ambiguous tail `gate` (p=0.46) where verbatim
 * abstained to `unknown` (p=0.83). That probe is far too small to settle anything, which is exactly
 * why both framings are runnable rather than one being chosen up front.
 */
function jevAuthored(run: RunOptions): boolean {
  return run.argv.includes("--jev-authored");
}

/** Per-kind descriptions for the authored framing, distilled from the enum block of
 *  `classifierPrompt`. Kept adjacent to the fixtures rather than in `eval-jev.ts`: this is what is
 *  being MEASURED, not transport. */
const JEV_CRITERIA: Record<AutopilotKind, string> = {
  gate: 'A procedural/workflow stop the agent could resolve itself and the answer is obviously "yes, keep going" — e.g. "shall I write the spec first?", "ready to start implementing?", "want me to commit now?". Only when proceeding is clearly correct.',
  question:
    "A real decision that needs a human — a product/requirements fork, ambiguous intent, a choice between materially different approaches, or anything the agent should not decide unilaterally.",
  finished:
    "The agent has done code/implementation work whose deliverable is a pull request, believes it is done, but has not opened the PR yet. It still needs to be driven to a PR.",
  complete:
    "The agent has fully delivered a task whose deliverable is NOT a pull request — research/investigation/analysis, creating a GitHub issue, or a one-off answer. Judge by the TASK: if it never asked for code changes, a finished agent is complete, not finished.",
  unknown:
    "You cannot confidently tell why the agent stopped. When in doubt choose this — never guess.",
};

const JEV_INSTRUCTIONS =
  "A coding agent's turn has ended and it is now waiting. Classify WHY it stopped, judging by " +
  "its task and the tail of its terminal.";

/** The option set with no descriptions — the verbatim framing's `state` already carries the
 *  definitions, so repeating them in `criteria` would say the same thing twice. */
const JEV_BARE_CRITERIA: Record<string, null> = Object.fromEntries(
  ALL_KINDS.map((kind) => [kind, null]),
);

export function jevQuestion(run: RunOptions): JevChoiceQuestion {
  return {
    type: "choice",
    instructions: JEV_INSTRUCTIONS,
    criteria: jevAuthored(run) ? JEV_CRITERIA : JEV_BARE_CRITERIA,
  };
}

/** The authored framing's state. Clipped exactly as `classifierPrompt` clips, so the two framings
 *  see the same number of characters of the same inputs and differ only in FRAMING. */
export function jevAuthoredState(fixture: Fixture): { task: string; terminal_tail: string } {
  return {
    task: fixture.taskPrompt.slice(0, 1500),
    terminal_tail: fixture.tail.slice(-20).join("\n").slice(0, 3000),
  };
}

/**
 * JEV's answer as the raw verdict object `SPEC.score` reads. `summary` is empty by construction —
 * JEV cannot generate prose, and this eval scores `kind` only, so nothing is lost HERE. (In
 * production the summary is operator-facing; see the research doc §3a.)
 *
 * An answer that is missing or outside the enum returns null. What the harness then does with it,
 * precisely: the trial is flagged `no-tool` and carries a mechanical sample, and `SPEC.score` gives
 * it `correct: false` — but its LABEL still renders as `unknown`, because that is what
 * `normalize(null)` returns. So read the `no-tool` tally, never the `unknown` count in the
 * distribution, to tell a failed trial from a genuine abstain.
 */
export function jevVerdict(
  answers: Record<string, JevChoiceAnswer>,
): Record<string, unknown> | null {
  const answer = answers[JEV_QUESTION_ID];
  if (typeof answer?.choice !== "string") return null;
  if (!ALL_KINDS.includes(answer.choice as AutopilotKind)) return null;
  return { kind: answer.choice, summary: "" };
}

export const SPEC: EvalSpec<Fixture> = {
  name: "stop-classifier",
  defaultModel: DEFAULT_MODEL,
  backends: {
    [JEV_BACKEND]: jevBackendSpec<Fixture>({
      defaultModel: JEV_MODEL,
      ask: (fixture, prompt, run) => ({
        state: jevAuthored(run) ? jevAuthoredState(fixture) : prompt,
        questions: { [JEV_QUESTION_ID]: jevQuestion(run) },
      }),
      verdict: jevVerdict,
    }),
  },
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
    ...(run.backend === JEV_BACKEND
      ? [
          jevAuthored(run)
            ? "jev framing: AUTHORED (structured state + per-kind criteria). NOTE: the operator-language " +
              "directives live in the PROMPT, so this framing does not exercise them at all."
            : "jev framing: VERBATIM (the production prompt IS the state; criteria are bare option names)",
          "jev is near-deterministic — T repeats measure far less variance here than on Claude.",
        ]
      : []),
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
    // `{kind:"unknown"}`. The distinction matters for the smoke gate, so recover it here: a verdict
    // is unrecognised when its `kind` is absent or outside the enum. A real `kind: "unknown"` is a
    // verdict, not a malformation.
    const kind = normalize(raw as RawVerdict | null).kind;
    const declared = (raw as RawVerdict | null)?.kind;
    const unrecognised =
      typeof declared !== "string" || !ALL_KINDS.includes(declared as AutopilotKind);
    // An UNRECOGNISED verdict is never correct — not on any fixture, and emphatically not on the
    // two that expect `unknown`.
    //
    // `normalize` answers `unknown` for everything it cannot read (bias to surface, which is right
    // in PRODUCTION), and `unknown` is the EXPECTED label on `ambiguous-unknown` /
    // `de-ambiguous-unknown`. So without this guard the two buckets whose entire job is measuring
    // abstention score a perfect 9/9 off failures that produced no judgement at all. Both shapes
    // reach here and both are covered, because `declared` is not a valid kind in either:
    //
    //   - NO verdict (`raw === null`) — no tool call, unparseable content, or a backend that could
    //     not read an answer. Also flagged `no-tool` / `parse-fail`.
    //   - A verdict that PARSES but whose `kind` is out of enum — e.g. a German-TRANSLATED kind.
    //     Not hypothetical: `CLASSIFIER_OUTPUT_LANGUAGE_DE` exists precisely because the model
    //     translates the enum token, and in production `normalize` turning that into `unknown` is
    //     the documented bug (research doc §3). Here it is the more dangerous of the two, because
    //     the trial looks mechanically clean — `toolUsed` and `parseOk` are both true — so only
    //     the `unrecognised` tally names it.
    const correct = !unrecognised && kind === fixture.expectedKind;
    return { label: kind, correct, unrecognised };
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
