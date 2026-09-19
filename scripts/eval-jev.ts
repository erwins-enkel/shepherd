// JEV (TypeSafe AI "System One") backend for the shared eval harness in `scripts/eval-core.ts`.
//
// WHY this exists: `docs/research/jev-system-one-models.md` recommends JEV for exactly two of
// Shepherd's judgement sites and parks the whole recommendation behind one gate — "add a JEV
// backend to the existing harness and run the existing stop-classifier fixture set; that is the
// go/no-go". This file is that backend, and nothing more. The go/no-go came back GO, so #2369 built
// the `Judge` seam and this file now calls IT (`src/judge-typesafe.ts`) rather than speaking HTTP
// itself — the eval and production share one transport, so neither can drift from the other.
//
// WHAT JEV IS, in the one sentence that shapes this file: it answers TYPED questions (choice /
// yes-no / score) against a shared `state` blob and returns the answer, the full probability
// distribution and a calibrated confidence — it cannot generate text, and it cannot return a value
// outside the option set it was given. So a `choice` question over the classifier's five kinds is
// structurally the same decision the Claude classifier makes, minus the prose `summary`.
//
// Only `choice` is implemented: it is the one primitive this eval asks for. `noul` and `score` get
// added when something measures them, not before.
//
// Everything here is pure or judge-injected, so `test/eval-jev.test.ts` exercises it with no
// network and no key.

import {
  addUsage,
  DETAIL_MODEL_KEY,
  type Backend,
  type BackendSpec,
  type EvalFixtureBase,
  type RunOptions,
  type Spend,
} from "./eval-core";
import type { Judge, JudgeChoiceAnswer, JudgeChoiceQuestion } from "../src/judge";
import { createTypeSafeJudge, judgeCostUsd, JUDGE_INPUT_USD_PER_MTOK } from "../src/judge-typesafe";

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

/**
 * The question/answer shapes are the PRODUCTION seam's (`src/judge.ts`), not this file's. #2369
 * moved the transport into `src/` behind the official SDK and re-pointed this backend at it, so the
 * eval exercises the code path production uses — the same drift-prevented-by-import property that
 * made feeding the real prompt as `state` the right call. This file no longer speaks HTTP.
 */
export type JevChoiceQuestion = JudgeChoiceQuestion;
export type JevChoiceAnswer = JudgeChoiceAnswer;

/** $/Mtok, re-exported from the production pricing constant so the two cannot drift.
 *  `src/pricing.ts` deliberately does not learn this model — see the note there. */
export const JEV_INPUT_USD_PER_MTOK = JUDGE_INPUT_USD_PER_MTOK;

export function jevPriceUsd(spend: Spend): number {
  return judgeCostUsd(spend.input);
}

/** What a fixture asks JEV: the shared `state` blob plus the questions asked against it. The eval
 *  owns this — the harness stays free of any knowledge of what is being judged. */
export type JevAsk<F extends EvalFixtureBase> = (
  fixture: F,
  /** The prompt `EvalSpec.buildPrompt` produced, for a framing that uses it AS the state. */
  prompt: string,
  run: RunOptions,
) => { state: unknown; questions: Record<string, JevChoiceQuestion> };

/** Turns JEV's answers into the raw verdict object the eval's own `score` reads — the SAME shape
 *  the Claude backend's model would have written to a file. `null` means no usable answer, which
 *  the harness records as a mechanical miss rather than as a wrong label. */
export type JevVerdict = (
  answers: Record<string, JevChoiceAnswer>,
) => Record<string, unknown> | null;

export interface JevBackendOptions<F extends EvalFixtureBase> {
  /** Pin a SNAPSHOT. The `-latest` alias would let calibration drift silently under a pinned
   *  floor — see the research doc's risk table. */
  defaultModel: string;
  ask: JevAsk<F>;
  verdict: JevVerdict;
}

/** Generous next to production's: an eval run is a batch job, and a trial lost to a slow response
 *  costs a paid re-run, whereas production would rather fall back to its spawn than wait. */
const EVAL_DEADLINE_MS = 60_000;

export function jevBackendSpec<F extends EvalFixtureBase>(
  options: JevBackendOptions<F>,
): BackendSpec<F> {
  return {
    defaultModel: options.defaultModel,
    priceUsd: jevPriceUsd,
    create: () => {
      const apiKey = process.env.JEV_API_KEY ?? "";
      if (!apiKey) {
        return (
          "no JEV_API_KEY — cannot run the live eval on the jev backend. Set the key " +
          "(~/.shepherd/eval.env) and retry."
        );
      }
      // Memoised per model: `--model` is a run-level choice the spec cannot see at create time, and
      // a client is pure configuration, so one per distinct model is both correct and cheap.
      const byModel = new Map<string, Judge>();
      const judgeFor = (model: string): Judge => {
        let judge = byModel.get(model);
        if (!judge) {
          judge = createTypeSafeJudge({
            apiKey,
            baseUrl: process.env.SHEPHERD_JUDGE_BASE_URL?.trim() || "https://api.typesafe.ai",
            model,
            deadlineMs: EVAL_DEADLINE_MS,
          });
          byModel.set(model, judge);
        }
        return judge;
      };
      return jevBackend(judgeFor, options);
    },
  };
}

/** The backend itself, over an injected judge factory — so a unit test drives it with a stub and
 *  needs neither a key nor a network. */
export function jevBackend<F extends EvalFixtureBase>(
  judgeFor: (model: string) => Judge,
  options: JevBackendOptions<F>,
): Backend<F> {
  return {
    trial: async (fixture, prompt, run, spend) => {
      const { state, questions } = options.ask(fixture, prompt, run);
      const result = await judgeFor(run.model).ask(state, questions);
      addUsage(spend, {
        usage: {
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
        },
      });
      const answers = result.answers as Record<string, JevChoiceAnswer>;
      const raw = options.verdict(answers);
      // `turns: 1` is the literal truth here — one request, one answer. There is no tool loop to
      // exhaust and no file for a model to decline to write, so the whole `no-tool` failure class
      // the Claude backend has to diagnose simply does not exist on this path. What CAN happen is
      // an answer the eval cannot read, and that is what `raw === null` reports.
      return {
        toolUsed: raw !== null,
        content: raw === null ? null : JSON.stringify(raw),
        turns: 1,
        ...(raw === null ? { stopReason: "jev-no-answer", text: JSON.stringify(answers) } : {}),
        detail: { ...answers, [DETAIL_MODEL_KEY]: result.model },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Offline confidence sweep
// ---------------------------------------------------------------------------

/**
 * Today the classifier's `unknown` is a CHOSEN enum value: the prompt works hard to make the model
 * abstain deliberately. JEV can abstain the same way — `unknown` is one of its options — but it can
 * ALSO abstain by spreading probability, which surfaces as low confidence on whatever it picked.
 * Those are different mechanisms, and which one to trust is the research doc's single most
 * important open question.
 *
 * It is answerable without a second paid run: every trial's choice, confidence and full
 * distribution are recorded in the JSON report, so a candidate "below this confidence, call it
 * `unknown`" rule can be replayed over completed data. That is what this does.
 */
export interface SweepTrial {
  choice: string;
  confidence: number;
  expected: string;
  /** For reporting WHICH fixtures a threshold rescues or breaks. */
  fixture: string;
  /** The full distribution, when the report recorded one. Absent on a report written before the
   *  seam carried it; the sweep never needs it, the measure ranking below does. */
  probabilities?: Readonly<Record<string, number>>;
}

export interface SweepRow {
  threshold: number;
  correct: number;
  trials: number;
  accuracy: number;
  /** Trials the threshold overrode to the abstain label. */
  abstained: number;
  /** Fixture ids whose trials the threshold turned from correct to wrong. */
  broke: string[];
  /** Fixture ids whose trials the threshold turned from wrong to correct. */
  rescued: string[];
}

export const DEFAULT_THRESHOLDS = [0, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

/**
 * Score every candidate threshold over recorded trials. `threshold: 0` is the no-rule baseline —
 * take JEV's top choice as-is. PURE.
 */
export function sweepThreshold(
  trials: SweepTrial[],
  abstainLabel: string,
  thresholds: number[] = DEFAULT_THRESHOLDS,
): SweepRow[] {
  return thresholds.map((threshold) => {
    let correct = 0;
    let abstained = 0;
    const broke = new Set<string>();
    const rescued = new Set<string>();
    for (const trial of trials) {
      const overridden = trial.confidence < threshold;
      const label = overridden ? abstainLabel : trial.choice;
      const wasCorrect = trial.choice === trial.expected;
      const isCorrect = label === trial.expected;
      if (overridden) abstained++;
      if (isCorrect) correct++;
      if (wasCorrect && !isCorrect) broke.add(trial.fixture);
      if (!wasCorrect && isCorrect) rescued.add(trial.fixture);
    }
    return {
      threshold,
      correct,
      trials: trials.length,
      accuracy: trials.length === 0 ? 0 : correct / trials.length,
      abstained,
      broke: [...broke].sort(),
      rescued: [...rescued].sort(),
    };
  });
}

/** Extract sweepable trials from a `--json` report. Skips fixtures with no `expected` or no
 *  recorded details (a non-JEV leg), so a mixed or partial report degrades to what it can score.
 *  PURE. */
export function sweepTrialsFrom(
  report: unknown,
  questionId: string,
  gatingOnly = true,
): SweepTrial[] {
  const results = (report as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const trials: SweepTrial[] = [];
  for (const entry of results) {
    const r = entry as {
      id?: unknown;
      expected?: unknown;
      gating?: unknown;
      trialDetails?: unknown;
    };
    if (typeof r.id !== "string" || typeof r.expected !== "string") continue;
    if (gatingOnly && r.gating !== true) continue;
    if (!Array.isArray(r.trialDetails)) continue;
    for (const detail of r.trialDetails) {
      const answer = (detail as Record<string, unknown> | null)?.[questionId] as
        (JevChoiceAnswer & { confidence?: number }) | undefined;
      // `vendorConfidence` is the seam's name for the field; `confidence` is what reports recorded
      // before #2369 renamed it. Both are read so an older report still sweeps.
      const confidence = answer?.vendorConfidence ?? answer?.confidence;
      if (typeof answer?.choice !== "string" || typeof confidence !== "number") continue;
      // Carried through untouched — `normalisedProbabilities` is the one place that decides
      // whether a recorded vector is usable, so a malformed one cannot be rejected twice by two
      // slightly different rules.
      const probabilities =
        typeof answer.probabilities === "object" && answer.probabilities !== null
          ? answer.probabilities
          : undefined;
      trials.push({
        choice: answer.choice,
        confidence,
        expected: r.expected,
        fixture: r.id,
        ...(probabilities === undefined ? {} : { probabilities }),
      });
    }
  }
  return trials;
}

export function formatSweep(rows: SweepRow[], abstainLabel: string): string {
  const lines = [
    `confidence sweep — below the threshold, the choice is overridden to "${abstainLabel}"`,
    "threshold  accuracy        abstained  effect",
  ];
  for (const row of rows) {
    const effect = [
      row.rescued.length > 0 ? `rescued: ${row.rescued.join(",")}` : "",
      row.broke.length > 0 ? `BROKE: ${row.broke.join(",")}` : "",
    ]
      .filter(Boolean)
      .join("  ");
    lines.push(
      `  ${row.threshold.toFixed(2)}     ` +
        `${(row.accuracy * 100).toFixed(1)}% (${row.correct}/${row.trials})`.padEnd(16) +
        `${String(row.abstained).padEnd(11)}${effect}`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Offline measure ranking (#2379)
// ---------------------------------------------------------------------------

/**
 * WHICH confidence measure actually separates right from wrong?
 *
 * The sweep above takes the vendor's `confidence` scalar as given, and #2364 recorded a result that
 * runs opposite to intuition on it — the abstains came back MORE confident than the correct `gate`
 * calls. The ecosystem scan (`docs/research/jev-ecosystem-scan.md` §2.1) supplies the explanation:
 * two independent sources report that the vendor's field is opaque and is NOT the top probability,
 * while every open implementation of the same wire format defines `confidence` as normalised
 * entropy — a different quantity entirely. So the scalar whose ordering looked inverted is
 * vendor-defined with no specification behind it.
 *
 * The diagnostic is to stop treating it as the only candidate: score each candidate by its AUROC
 * against correctness and use whichever separates best. **An AUROC at or below 0.5 is precisely the
 * signature of "this measure runs opposite to intuition"**, which turns a hand-observed oddity into
 * a measured one.
 *
 * Forward-looking by design. `classifyStop` ships with NO threshold and that is measured, not
 * assumed (#2369) — nothing here disturbs it. But it also tells us whether
 * `JudgeChoiceAnswer.probabilities` — the quantity `src/judge.ts` deliberately carries across the
 * seam INSTEAD of the vendor scalar — earns its place, which is the contract that file exists to
 * enforce.
 *
 * Everything below is PURE and offline: it reads a finished report. No key, no paid re-run.
 */

/** The fields of a `JudgeChoiceAnswer` a measure reads. Both are optional because a report can
 *  predate either one, and a measure that cannot be computed says so rather than inventing a
 *  number. */
export interface ConfidenceDistribution {
  probabilities?: Readonly<Record<string, number>>;
  vendorConfidence?: number;
}

/** A candidate measure. `of` returns `null` when this answer cannot support it — never a fallback
 *  value, which would enter the ranking as if it had been measured. */
export interface ConfidenceMeasure {
  name: string;
  of: (distribution: ConfidenceDistribution) => number | null;
}

/**
 * The distribution as probabilities summing to 1, or `null` if it is not one.
 *
 * NORMALISING IS NOT PEDANTRY HERE: the vendor returns probabilities rounded to two decimals
 * (research §2.2), so a real vector sums to 0.99 or 1.02, and entropy computed over it is simply
 * wrong. A single malformed entry invalidates the WHOLE vector rather than being dropped, because
 * dropping one would silently change `K` and hand back a plausible-looking number derived from a
 * broken input — the same reasoning `scripts/eval-drift.ts` applies to its tallies.
 */
function normalisedProbabilities(distribution: ConfidenceDistribution): number[] | null {
  const values = Object.values(distribution.probabilities ?? {});
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    sum += value;
  }
  if (sum <= 0) return null;
  return values.map((value) => value / sum);
}

/** Descending, so `[0]` is the winner and `[1]` the runner-up. */
function ranked(distribution: ConfidenceDistribution): number[] | null {
  const probabilities = normalisedProbabilities(distribution);
  return probabilities === null ? null : probabilities.sort((a, b) => b - a);
}

/** The vendor's own scalar — the incumbent, and the one a gate inherits by accident. */
export const vendorMeasure: ConfidenceMeasure = {
  name: "vendorConfidence",
  of: (distribution) =>
    typeof distribution.vendorConfidence === "number" &&
    Number.isFinite(distribution.vendorConfidence)
      ? distribution.vendorConfidence
      : null,
};

/** How much probability the winner got. */
export const topProbabilityMeasure: ConfidenceMeasure = {
  name: "topProbability",
  of: (distribution) => ranked(distribution)?.[0] ?? null,
};

/** How far the winner beat the runner-up. A choice is RELATIVE (see contract 2 in `src/judge.ts`),
 *  so the gap between the top two is the quantity that matches what the answer means. */
export const marginMeasure: ConfidenceMeasure = {
  name: "margin",
  of: (distribution) => {
    const probabilities = ranked(distribution);
    if (probabilities === null || probabilities.length < 2) return null;
    return probabilities[0]! - probabilities[1]!;
  },
};

/** `1 - H(p)/log K` — what every open implementation of this wire format calls `confidence`.
 *  Undefined for `K < 2`, where `log K` is zero. */
export const normalisedEntropyMeasure: ConfidenceMeasure = {
  name: "normalisedEntropy",
  of: (distribution) => {
    const probabilities = normalisedProbabilities(distribution);
    if (probabilities === null || probabilities.length < 2) return null;
    let entropy = 0;
    for (const p of probabilities) {
      // `0 log 0` is 0 by convention, and `Math.log(0)` is -Infinity, so the guard is load-bearing.
      if (p > 0) entropy -= p * Math.log(p);
    }
    const normalised = 1 - entropy / Math.log(probabilities.length);
    // Float drift can push a saturated or uniform vector a hair outside [0, 1].
    return Math.min(1, Math.max(0, normalised));
  },
};

/** Every candidate, in the order the research doc names them. */
export const CONFIDENCE_MEASURES: readonly ConfidenceMeasure[] = [
  vendorMeasure,
  topProbabilityMeasure,
  marginMeasure,
  normalisedEntropyMeasure,
];

export interface AurocSample {
  score: number;
  correct: boolean;
}

export interface AurocResult {
  /** `null` when either class is below {@link MIN_CLASS_SUPPORT} — see there for why. */
  auroc: number | null;
  /** Correct trials that carried a score. */
  positives: number;
  /** Wrong trials that carried a score. */
  negatives: number;
}

/**
 * Below this many trials in EITHER class, no ranking is reported.
 *
 * This fixture set is 12 fixtures and the verbatim framing scores near its ceiling, so the wrong
 * trials are few. With a handful of them, one flipped trial moves AUROC further than the whole gap
 * between two measures — the ranking would be reporting noise in a tone that reads as measurement.
 * "Insufficient support" is a result; a number computed off three negatives is not.
 */
export const MIN_CLASS_SUPPORT = 5;

/**
 * AUROC of `score` against `correct`, as the Mann-Whitney U statistic over MID-RANKS.
 *
 * Mid-ranks are the whole reason this is rank-based rather than a pairwise count. The vendor rounds
 * probabilities to two decimals, so on a saturated distribution ties are not an edge case — they
 * are the bulk of the data. A naive `score > other` count scores every tied pair as a loss and
 * would depress exactly the measures that saturate, which is the failure this function exists to
 * avoid. A tie contributes 0.5, which is what mid-ranks give for free.
 *
 * PURE.
 */
export function auroc(samples: AurocSample[], minSupport = MIN_CLASS_SUPPORT): AurocResult {
  const positives = samples.filter((sample) => sample.correct).length;
  const negatives = samples.length - positives;
  // `Math.max(1, …)` so a caller that passes `minSupport: 0` to disable the floor still cannot
  // divide by an empty class: the result would be a silent NaN, which reads as a measurement.
  const floor = Math.max(1, minSupport);
  if (positives < floor || negatives < floor) return { auroc: null, positives, negatives };

  const sorted = [...samples].sort((a, b) => a.score - b.score);
  let rankSum = 0;
  let index = 0;
  while (index < sorted.length) {
    let last = index;
    while (last + 1 < sorted.length && sorted[last + 1]!.score === sorted[index]!.score) last++;
    // Ranks are 1-based, so the block spans ranks index+1 .. last+1 and their mean is this.
    const midRank = (index + last + 2) / 2;
    for (let k = index; k <= last; k++) if (sorted[k]!.correct) rankSum += midRank;
    index = last + 1;
  }
  return {
    auroc: (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives),
    positives,
    negatives,
  };
}

export interface MeasureRanking extends AurocResult {
  name: string;
  /** Trials whose recorded answer could not support this measure at all. */
  skipped: number;
}

/**
 * Deliberately COARSE, and deliberately not a significance test.
 *
 * A proper band would be a confidence interval, which on this fixture set would be wide enough to
 * swallow every measure and would dress a small sample in statistical clothing. This just keeps the
 * word "separates" off a measure sitting on chance. The support counts printed beside it are what a
 * reader should actually weigh.
 */
const CHANCE_BAND = 0.05;

/** Plain language for one row, so the reader is not left to interpret a bare number. */
export function measureVerdict(row: MeasureRanking): string {
  if (row.auroc === null) return "insufficient support";
  if (row.auroc >= 0.5 + CHANCE_BAND) return "separates";
  if (row.auroc <= 0.5 - CHANCE_BAND) return "runs opposite";
  return "at chance";
}

/**
 * Score every candidate measure over recorded trials, best first, unrankable last.
 *
 * Correctness is `choice === expected` — the SAME predicate the threshold sweep uses, so the two
 * analyses cannot disagree about whether a given trial was right. PURE.
 */
export function rankMeasures(
  trials: SweepTrial[],
  measures: readonly ConfidenceMeasure[] = CONFIDENCE_MEASURES,
  minSupport = MIN_CLASS_SUPPORT,
): MeasureRanking[] {
  const rows = measures.map((measure) => {
    const samples: AurocSample[] = [];
    let skipped = 0;
    for (const trial of trials) {
      const score = measure.of({
        vendorConfidence: trial.confidence,
        ...(trial.probabilities === undefined ? {} : { probabilities: trial.probabilities }),
      });
      if (score === null) {
        skipped++;
        continue;
      }
      samples.push({ score, correct: trial.choice === trial.expected });
    }
    return { name: measure.name, ...auroc(samples, minSupport), skipped };
  });
  // Stable, so measures that tie keep CONFIDENCE_MEASURES order rather than an arbitrary one.
  return rows.sort((a, b) => {
    if (a.auroc === null || b.auroc === null)
      return Number(a.auroc === null) - Number(b.auroc === null);
    return b.auroc - a.auroc;
  });
}

export function formatMeasureRanking(rows: MeasureRanking[]): string {
  const lines = [
    "confidence measures ranked by AUROC against correctness " +
      "(1.00 separates perfectly, 0.50 is chance, below 0.50 runs opposite)",
    "measure             auroc   correct  wrong  skipped  reading",
  ];
  for (const row of rows) {
    lines.push(
      `  ${row.name.padEnd(18)}` +
        `${row.auroc === null ? "  —  " : row.auroc.toFixed(3)}`.padEnd(8) +
        `${String(row.positives).padEnd(9)}${String(row.negatives).padEnd(7)}` +
        `${String(row.skipped).padEnd(9)}${measureVerdict(row)}`,
    );
  }
  return lines.join("\n");
}

if (import.meta.main) {
  // `bun run scripts/eval-jev.ts <report.json> [questionId] [--all] [--auroc]` — replays a
  // completed run's recorded distributions. Reads a file; makes no calls and needs no key.
  const [path, questionId = "kind"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (path === undefined) {
    console.error(
      "usage: bun run scripts/eval-jev.ts <report.json> [questionId] [--all] [--auroc]",
    );
    process.exit(2);
  }
  const report: unknown = await Bun.file(path).json();
  const trials = sweepTrialsFrom(report, questionId, !process.argv.includes("--all"));
  if (trials.length === 0) {
    console.error(`no sweepable trials in ${path} for question "${questionId}"`);
    process.exit(3);
  }
  console.log(
    process.argv.includes("--auroc")
      ? formatMeasureRanking(rankMeasures(trials))
      : formatSweep(sweepThreshold(trials, "unknown"), "unknown"),
  );
}
