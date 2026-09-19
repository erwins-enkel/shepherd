import { test, expect } from "bun:test";
import {
  DEFAULT_THRESHOLDS,
  JEV_INPUT_USD_PER_MTOK,
  formatSweep,
  jevBackend,
  jevPriceUsd,
  sweepThreshold,
  sweepTrialsFrom,
  type JevChoiceAnswer,
  type SweepTrial,
} from "../scripts/eval-jev";
import type { Judge, JudgeResult } from "../src/judge";
import {
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
  expect(capture.detail).toEqual({ kind: answer() as unknown as Record<string, unknown> });
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
    { choice: "gate", confidence: 0.9, expected: "gate", fixture: "gating-with-details" },
  ]);
  expect(sweepTrialsFrom(report, "kind", false).map((t) => t.fixture)).toEqual([
    "gating-with-details",
    "baseline",
  ]);
  expect(sweepTrialsFrom({}, "kind")).toEqual([]);
});

test("the sweep renders every candidate threshold with its effect", () => {
  const rendered = formatSweep(sweepThreshold(TRIALS, "unknown", DEFAULT_THRESHOLDS), "unknown");
  expect(rendered).toContain("0.00");
  expect(rendered).toContain("rescued: ambiguous");
  expect(rendered).toContain("BROKE: finished-pr");
});
