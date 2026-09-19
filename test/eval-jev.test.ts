import { test, expect } from "bun:test";
import {
  CONFIDENCE_MEASURES,
  DEFAULT_THRESHOLDS,
  JEV_INPUT_USD_PER_MTOK,
  MIN_CLASS_SUPPORT,
  auroc,
  formatMeasureRanking,
  formatSweep,
  jevBackend,
  jevPriceUsd,
  marginMeasure,
  measureVerdict,
  normalisedEntropyMeasure,
  rankMeasures,
  sweepThreshold,
  sweepTrialsFrom,
  topProbabilityMeasure,
  vendorMeasure,
  type AurocSample,
  type JevChoiceAnswer,
  type SweepTrial,
} from "../scripts/eval-jev";
import type { Judge, JudgeResult } from "../src/judge";
import {
  DETAIL_MODEL_KEY,
  emptySpend,
  isCannotRun,
  isPermanent,
  parseArgs,
  type EvalFixtureBase,
  type EvalSpec,
  type RunOptions,
} from "../scripts/eval-core";

// HERMETIC: the judge is injected, so nothing here calls api.typesafe.ai and no JEV_API_KEY is
// read. The transport itself lives in `src/judge-typesafe.ts` since #2369 and is covered by
// `test/judge-typesafe.test.ts`, which drives the real SDK over an injected `fetch`.

interface TestFixture extends EvalFixtureBase {
  expected: string;
}

const FIXTURE: TestFixture = {
  id: "f1",
  origin: "synthetic",
  gating: true,
  note: "",
  expected: "a",
};

const SPEC: EvalSpec<TestFixture> = {
  name: "t",
  defaultModel: "m",
  defaultTrials: 1,
  defaultTemperature: 1,
  floor: 0.5,
  fixtures: [FIXTURE],
  labels: ["a", "b"],
  tools: [],
  maxTurns: 1,
  maxTokens: 16,
  buildPrompt: () => "THE PROMPT",
  score: () => ({ label: "a", correct: true }),
};

const RUN: RunOptions = parseArgs(SPEC, ["--backend", "jev", "--model", "jev-1.13.0"]);

function answer(over: Partial<JevChoiceAnswer> = {}): JevChoiceAnswer {
  return {
    type: "choice",
    choice: "a",
    vendorConfidence: 0.84,
    probabilities: { a: 0.88, b: 0.12 },
    ...over,
  };
}

interface AskCall {
  state: unknown;
  questions: Record<string, unknown>;
  model: string;
}

function stubJudge(over: Partial<JudgeResult<Record<string, never>>> = {}): {
  judgeFor: (model: string) => Judge;
  calls: AskCall[];
} {
  const calls: AskCall[] = [];
  return {
    calls,
    judgeFor: (model) => ({
      ask: async (state, questions) => {
        calls.push({ state, questions, model });
        return {
          model: "jev-1.13.0",
          answers: {},
          usage: { inputTokens: 0, outputTokens: 0 },
          costUsd: 0,
          ...over,
        } as never;
      },
    }),
  };
}

const ASK = { ask: () => ({ state: "S", questions: {} }), defaultModel: "jev-1.13.0" };

// --- the backend ------------------------------------------------------------

test("a choice answer becomes the same verdict shape the Claude backend writes to a file", async () => {
  const { judgeFor, calls } = stubJudge({
    answers: { kind: answer() } as never,
    usage: { inputTokens: 606, outputTokens: 52 },
  });
  const spend = emptySpend();
  const backend = jevBackend(judgeFor, {
    ...ASK,
    ask: (_f, prompt) => ({ state: prompt, questions: {} }),
    verdict: (answers) => ({ kind: answers.kind?.choice, summary: "" }),
  });

  const capture = await backend.trial(FIXTURE, "THE PROMPT", RUN, spend);

  expect(capture.toolUsed).toBe(true);
  expect(JSON.parse(capture.content!)).toEqual({ kind: "a", summary: "" });
  expect(capture.turns).toBe(1);
  // The state is whatever the EVAL chose — here the production prompt verbatim.
  expect(calls[0]!.state).toBe("THE PROMPT");
  // `--model` reaches the transport as the model the judge is built for — the pin is not bypassed.
  expect(calls[0]!.model).toBe("jev-1.13.0");
  // Usage accrues through the harness's own meter, so the spend ceiling governs this backend too.
  expect(spend.calls).toBe(1);
  expect(spend.input).toBe(606);
});

test("the full distribution and confidence are recorded per trial — the offline sweep's raw material", async () => {
  const { judgeFor } = stubJudge({ answers: { kind: answer() } as never });
  const backend = jevBackend(judgeFor, { ...ASK, verdict: () => ({ kind: "a" }) });
  const capture = await backend.trial(FIXTURE, "p", RUN, emptySpend());
  expect(capture.detail).toEqual({
    kind: answer() as unknown as Record<string, unknown>,
    [DETAIL_MODEL_KEY]: "jev-1.13.0",
  });
});

test("the model that ANSWERED is recorded, so a silent re-point is catchable (#2377)", async () => {
  // The vendor is asked for the pin and reports back something else. Nothing about the ANSWER
  // changes — which is exactly why an accuracy check alone would never notice.
  const { judgeFor } = stubJudge({ answers: { kind: answer() } as never, model: "jev-1.14.0" });
  const backend = jevBackend(judgeFor, { ...ASK, verdict: () => ({ kind: "a" }) });
  const capture = await backend.trial(FIXTURE, "p", RUN, emptySpend());
  expect(capture.detail?.[DETAIL_MODEL_KEY]).toBe("jev-1.14.0");
  expect(capture.toolUsed).toBe(true);
});

test("the reserved model key cannot collide with a question id, and the sweep ignores it", () => {
  // `detail` is otherwise keyed by question id; `sweepTrialsFrom` indexes it by one.
  expect(DETAIL_MODEL_KEY.startsWith("__")).toBe(true);
  const trials = sweepTrialsFrom(
    {
      results: [
        {
          id: "f1",
          expected: "a",
          gating: true,
          trialDetails: [{ kind: answer(), [DETAIL_MODEL_KEY]: "jev-1.13.0" }],
        },
      ],
    },
    DETAIL_MODEL_KEY,
  );
  expect(trials).toEqual([]);
});

test("an unreadable answer produces no verdict at all", async () => {
  // JEV's decoder cannot emit an out-of-enum value, so this is defensive. The scoring consequence
  // — that such a trial is never counted CORRECT, including on the abstain fixtures — is asserted
  // in `eval-stop-classifier.test.ts`, since it lives in that eval's scorer, not here.
  const { judgeFor } = stubJudge({ answers: {} as never });
  const backend = jevBackend(judgeFor, { ...ASK, verdict: () => null });
  const capture = await backend.trial(FIXTURE, "p", RUN, emptySpend());
  expect(capture.toolUsed).toBe(false);
  expect(capture.content).toBeNull();
  expect(capture.stopReason).toBe("jev-no-answer");
  // The answers ride along so a verdict-less trial is diagnosable from the run's own log.
  expect(capture.text).toBe("{}");
});

// --- pricing ----------------------------------------------------------------

test("JEV bills input only, so output tokens are free", () => {
  expect(jevPriceUsd({ ...emptySpend(), input: 1_000_000, output: 5_000_000 })).toBeCloseTo(
    JEV_INPUT_USD_PER_MTOK,
    9,
  );
  // A realistic full run of the classifier fixture set: ~54 trials x ~1k tokens.
  expect(jevPriceUsd({ ...emptySpend(), input: 54_000 })).toBeLessThan(0.01);
});

// --- transport error text, as the harness classifies it ---------------------

test("a dead key fails fast because the seam's error text is what isPermanent matches", () => {
  // Captured live: the body carries `authentication_error`, and `JudgeError`'s message leads with
  // the status. Both are load-bearing — without them a bad key burns the retry backoff once per
  // trial across the whole pool. #2369 changed the prefix from `JEV API` to `judge:` when the
  // transport moved into `src/`; the classification must survive that, which is what this pins.
  const dead =
    'judge: 401 {"detail":{"error_type":"authentication_error","message":"Cannot authenticate with the server."}}';
  expect(isPermanent(dead)).toBe(true);
  expect(isCannotRun(dead)).toBe(true);
  // A 429 is explicitly NOT permanent — backoff is what it exists for.
  expect(isPermanent("judge: 429 rate limited")).toBe(false);
  expect(isCannotRun("judge: 429 rate limited")).toBe(true);
});

// --- the offline confidence sweep -------------------------------------------

const TRIALS: SweepTrial[] = [
  // Confident and right — no threshold should touch it until it is absurdly high.
  { choice: "gate", confidence: 0.88, expected: "gate", fixture: "gate-commit" },
  // Unconfident and WRONG: the case an abstain rule exists to rescue.
  { choice: "gate", confidence: 0.32, expected: "unknown", fixture: "ambiguous" },
  // Unconfident but RIGHT: the case an abstain rule costs you.
  { choice: "finished", confidence: 0.41, expected: "finished", fixture: "finished-pr" },
];

test("threshold 0 is the no-rule baseline — JEV's top choice, as-is", () => {
  const [baseline] = sweepThreshold(TRIALS, "unknown", [0]);
  expect(baseline!.abstained).toBe(0);
  expect(baseline!.correct).toBe(2);
  expect(baseline!.accuracy).toBeCloseTo(2 / 3, 5);
  expect(baseline!.rescued).toEqual([]);
  expect(baseline!.broke).toEqual([]);
});

test("a threshold both RESCUES and BREAKS, and the sweep names which fixtures", () => {
  // At 0.35 only the wrong low-confidence pick is overridden.
  const [low] = sweepThreshold(TRIALS, "unknown", [0.35]);
  expect(low!.correct).toBe(3);
  expect(low!.rescued).toEqual(["ambiguous"]);
  expect(low!.broke).toEqual([]);

  // At 0.5 the correct-but-unconfident one is overridden too — a real cost, made visible rather
  // than averaged away.
  const [high] = sweepThreshold(TRIALS, "unknown", [0.5]);
  expect(high!.abstained).toBe(2);
  expect(high!.correct).toBe(2);
  expect(high!.rescued).toEqual(["ambiguous"]);
  expect(high!.broke).toEqual(["finished-pr"]);
});

test("an abstain that was already the expected label is not counted as a rescue", () => {
  const rows = sweepThreshold(
    [{ choice: "unknown", confidence: 0.2, expected: "unknown", fixture: "x" }],
    "unknown",
    [0.5],
  );
  expect(rows[0]!.correct).toBe(1);
  expect(rows[0]!.rescued).toEqual([]);
  expect(rows[0]!.broke).toEqual([]);
});

test("sweepTrialsFrom reads a --json report, and skips what it cannot score", () => {
  const report = {
    results: [
      {
        id: "gating-with-details",
        expected: "gate",
        gating: true,
        trialDetails: [{ kind: answer({ choice: "gate", vendorConfidence: 0.9 }) }],
      },
      // Baseline fixture — excluded by default, since the gate is defined over gating fixtures.
      {
        id: "baseline",
        expected: "gate",
        gating: false,
        trialDetails: [{ kind: answer() }],
      },
      // An Anthropic-leg fixture in the same report carries no details at all.
      { id: "no-details", expected: "gate", gating: true },
      // A detail whose question id does not match is not silently mis-read.
      { id: "other-question", expected: "gate", gating: true, trialDetails: [{ other: answer() }] },
    ],
  };
  expect(sweepTrialsFrom(report, "kind")).toEqual([
    {
      choice: "gate",
      confidence: 0.9,
      expected: "gate",
      fixture: "gating-with-details",
      // Carried since #2379 — the measure ranking's raw material. The sweep ignores it.
      probabilities: { a: 0.88, b: 0.12 },
    },
  ]);
  expect(sweepTrialsFrom(report, "kind", false).map((t) => t.fixture)).toEqual([
    "gating-with-details",
    "baseline",
  ]);
  expect(sweepTrialsFrom({}, "kind")).toEqual([]);
});

test("the run's model rides in the same detail object and is not mistaken for an answer", () => {
  // #2377 put DETAIL_MODEL_KEY beside the answers so a re-point is visible per trial. Extraction is
  // BY QUESTION ID, so that key is ignored by construction — pinned here so it stays that way.
  const report = {
    results: [
      {
        id: "f",
        expected: "gate",
        gating: true,
        trialDetails: [{ kind: answer({ choice: "gate" }), [DETAIL_MODEL_KEY]: "jev-1.13.0" }],
      },
    ],
  };
  expect(sweepTrialsFrom(report, "kind").map((t) => t.choice)).toEqual(["gate"]);
  expect(sweepTrialsFrom(report, DETAIL_MODEL_KEY)).toEqual([]);
});

test("the sweep renders every candidate threshold with its effect", () => {
  const rendered = formatSweep(sweepThreshold(TRIALS, "unknown", DEFAULT_THRESHOLDS), "unknown");
  expect(rendered).toContain("0.00");
  expect(rendered).toContain("rescued: ambiguous");
  expect(rendered).toContain("BROKE: finished-pr");
});

// --- confidence measures (#2379) --------------------------------------------

test("each measure reads the quantity it names", () => {
  const distribution = { probabilities: { a: 0.6, b: 0.3, c: 0.1 }, vendorConfidence: 0.84 };
  expect(vendorMeasure.of(distribution)).toBe(0.84);
  expect(topProbabilityMeasure.of(distribution)).toBeCloseTo(0.6, 9);
  expect(marginMeasure.of(distribution)).toBeCloseTo(0.3, 9);
});

test("normalised entropy is 0 on a uniform distribution and 1 on a one-hot one", () => {
  expect(
    normalisedEntropyMeasure.of({ probabilities: { a: 0.25, b: 0.25, c: 0.25, d: 0.25 } }),
  ).toBeCloseTo(0, 9);
  expect(normalisedEntropyMeasure.of({ probabilities: { a: 1, b: 0, c: 0 } })).toBeCloseTo(1, 9);
});

test("a vector that does not sum to 1 is normalised, not rejected", () => {
  // The vendor rounds to two decimals, so this is the ORDINARY case, not a malformed one: an
  // un-normalised vector would put entropy on the wrong scale entirely.
  const rounded = { probabilities: { a: 0.5, b: 0.49 } };
  expect(topProbabilityMeasure.of(rounded)).toBeCloseTo(0.5 / 0.99, 9);
  expect(normalisedEntropyMeasure.of(rounded)).toBeCloseTo(
    normalisedEntropyMeasure.of({ probabilities: { a: 0.5 / 0.99, b: 0.49 / 0.99 } })!,
    9,
  );
});

test("an unmeasurable answer yields null, never a fallback number", () => {
  // A single option: no runner-up to be ahead of, and log 1 = 0.
  expect(marginMeasure.of({ probabilities: { a: 1 } })).toBeNull();
  expect(normalisedEntropyMeasure.of({ probabilities: { a: 1 } })).toBeNull();
  expect(topProbabilityMeasure.of({ probabilities: { a: 1 } })).toBeCloseTo(1, 9);
  // No distribution at all, and no vendor scalar at all.
  for (const measure of CONFIDENCE_MEASURES) {
    expect(measure.of({})).toBeNull();
  }
  // One broken entry invalidates the WHOLE vector — dropping it would change K silently.
  const broken = { probabilities: { a: 0.5, b: Number.NaN } };
  expect(topProbabilityMeasure.of(broken)).toBeNull();
  expect(normalisedEntropyMeasure.of(broken)).toBeNull();
  expect(topProbabilityMeasure.of({ probabilities: { a: 0, b: 0 } })).toBeNull();
});

// --- AUROC -------------------------------------------------------------------

function samples(...rows: [score: number, correct: boolean][]): AurocSample[] {
  return rows.map(([score, correct]) => ({ score, correct }));
}

/** MIN_CLASS_SUPPORT trials of each class, so support never masks the arithmetic under test. */
function balanced(correctScore: number, wrongScore: number): AurocSample[] {
  return [
    ...Array.from({ length: MIN_CLASS_SUPPORT }, () => ({ score: correctScore, correct: true })),
    ...Array.from({ length: MIN_CLASS_SUPPORT }, () => ({ score: wrongScore, correct: false })),
  ];
}

test("perfect separation is 1, the inversion is 0, and no separation at all is 0.5", () => {
  expect(auroc(balanced(0.9, 0.1)).auroc).toBe(1);
  // The #2364 signature: the WRONG trials are the confident ones.
  expect(auroc(balanced(0.1, 0.9)).auroc).toBe(0);
  // Every score identical — all ties, which mid-ranks must score as chance rather than as a loss.
  expect(auroc(balanced(0.5, 0.5)).auroc).toBe(0.5);
});

test("a tie between a correct and a wrong trial counts as half, not as a loss", () => {
  // 3 correct / 3 wrong so the hand-computed value is checkable: one tied pair (0.5), the rest
  // strictly ordered in the correct trials' favour.
  const rows = auroc(
    samples([0.9, true], [0.8, true], [0.5, true], [0.5, false], [0.4, false], [0.3, false]),
    3,
  );
  expect(rows.positives).toBe(3);
  expect(rows.negatives).toBe(3);
  // 9 pairs: 8 won outright, 1 tied → (8 + 0.5) / 9.
  expect(rows.auroc).toBeCloseTo(8.5 / 9, 9);
});

test("a class too thin to measure reports its support instead of a number", () => {
  const thin = [
    ...Array.from({ length: 20 }, () => ({ score: 0.9, correct: true })),
    { score: 0.1, correct: false },
  ];
  const result = auroc(thin);
  expect(result.auroc).toBeNull();
  expect(result.positives).toBe(20);
  expect(result.negatives).toBe(1);
  // An empty class is the degenerate case of the same rule.
  expect(auroc([]).auroc).toBeNull();
});

// --- the ranking -------------------------------------------------------------

function trial(over: Partial<SweepTrial> = {}): SweepTrial {
  return {
    choice: "gate",
    expected: "gate",
    fixture: "f",
    confidence: 0.9,
    probabilities: { gate: 0.9, unknown: 0.1 },
    ...over,
  };
}

test("the ranking puts the measure that separates best first and the unrankable last", () => {
  // topProbability separates perfectly; vendorConfidence is inverted; the trials carry two options
  // so margin and normalised entropy are measurable and move WITH topProbability.
  const trials = [
    ...Array.from({ length: MIN_CLASS_SUPPORT }, () =>
      trial({ confidence: 0.1, probabilities: { gate: 0.99, unknown: 0.01 } }),
    ),
    ...Array.from({ length: MIN_CLASS_SUPPORT }, () =>
      trial({
        choice: "question",
        confidence: 0.99,
        probabilities: { question: 0.51, gate: 0.49 },
      }),
    ),
  ];
  const rows = rankMeasures(trials);
  expect(rows.map((r) => r.name)[0]).toBe("topProbability");
  expect(rows[0]!.auroc).toBe(1);
  expect(rows[0]!.positives).toBe(MIN_CLASS_SUPPORT);
  expect(rows[0]!.negatives).toBe(MIN_CLASS_SUPPORT);
  // The vendor scalar runs opposite here — the exact shape #2364 observed by hand, and the whole
  // reason the reading is spelled out in words rather than left as a bare number.
  const vendor = rows.find((r) => r.name === "vendorConfidence")!;
  expect(vendor.auroc).toBe(0);
  expect(measureVerdict(vendor)).toBe("runs opposite");
  expect(measureVerdict(rows[0]!)).toBe("separates");
  expect(rows.at(-1)!.name).toBe("vendorConfidence");
});

test("a measure sitting on chance is not reported as separating", () => {
  const onChance = { name: "x", auroc: 0.5, positives: 9, negatives: 9, skipped: 0 };
  expect(measureVerdict(onChance)).toBe("at chance");
  expect(measureVerdict({ ...onChance, auroc: 0.52 })).toBe("at chance");
  expect(measureVerdict({ ...onChance, auroc: null })).toBe("insufficient support");
});

test("disabling the support floor still cannot divide by an empty class", () => {
  // `minSupport: 0` is a legitimate ask (rank whatever there is); an empty class is still NaN.
  expect(auroc([{ score: 1, correct: true }], 0).auroc).toBeNull();
});

test("a report with no distributions ranks nothing and says how many trials it skipped", () => {
  const trials = Array.from({ length: MIN_CLASS_SUPPORT * 2 }, (_, i) =>
    trial({ probabilities: undefined, choice: i % 2 === 0 ? "gate" : "question" }),
  );
  const rows = rankMeasures(trials);
  const top = rows.find((r) => r.name === "topProbability")!;
  expect(top.auroc).toBeNull();
  expect(top.skipped).toBe(trials.length);
  // The vendor scalar is still there, so it alone stays measurable.
  expect(rows.find((r) => r.name === "vendorConfidence")!.skipped).toBe(0);
});

test("the ranking renders every measure with its support", () => {
  const rendered = formatMeasureRanking(rankMeasures([trial()]));
  for (const measure of CONFIDENCE_MEASURES) expect(rendered).toContain(measure.name);
  expect(rendered).toContain("insufficient support");
});
