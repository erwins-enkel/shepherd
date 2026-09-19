// JEV (TypeSafe AI "System One") backend for the shared eval harness in `scripts/eval-core.ts`.
//
// WHY this exists: `docs/research/jev-system-one-models.md` recommends JEV for exactly two of
// Shepherd's judgement sites and parks the whole recommendation behind one gate — "add a JEV
// backend to the existing harness and run the existing stop-classifier fixture set; that is the
// go/no-go". This file is that backend, and nothing more. No production code calls it; when and if
// the `Judge` seam is built, the transport below is what moves to `src/`.
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
// Everything here is pure or transport-injected, so `test/eval-jev.test.ts` exercises it with no
// network and no key.

import {
  addUsage,
  type Backend,
  type BackendSpec,
  type EvalFixtureBase,
  type RunOptions,
  type Spend,
} from "./eval-core";

// ---------------------------------------------------------------------------
// Wire types — verified against a live probe, not only against the docs
// ---------------------------------------------------------------------------

const JEV_URL = "https://api.typesafe.ai/v1/systemone";

/** A `choice` question: pick exactly one named option. `criteria` maps each option name to its
 *  description, or to `null` when the option names are self-describing given the `state`. */
export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

/** A `choice` answer. `confidence` is the distribution's peakedness — reported SEPARATELY from the
 *  answer, which is the property that lets "which option" and "should we act on it" be two
 *  decisions instead of one. */
export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevResponse {
  model: string;
  answers: Record<string, JevChoiceAnswer>;
  /** Field names match the Anthropic shape, so {@link addUsage} reads it directly. */
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface JevRequest {
  model: string;
  /** Text, or any JSON value — the docs allow an object, and the live API accepts one. */
  state: unknown;
  questions: Record<string, JevChoiceQuestion>;
}

/** The transport. Injected so the backend is testable without network access. */
export type JevSend = (body: JevRequest) => Promise<JevResponse>;

export function jevSend(apiKey: string): JevSend {
  return async (body) => {
    const res = await fetch(JEV_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // The status goes FIRST and verbatim because the harness's `isPermanent` / `isCannotRun`
      // classify on this message. Verified live: a bad key returns 401 with an
      // `authentication_error` body, which `isPermanent` already matches, so a dead key fails fast
      // instead of burning the backoff once per trial across the pool.
      throw new Error(`JEV API ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    return (await res.json()) as JevResponse;
  };
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/** $/Mtok. Input only — JEV bills no output. `src/pricing.ts` deliberately does NOT learn this
 *  model: its table is real Anthropic list prices feeding the usage lens, and a non-Anthropic row
 *  would pollute it. Left to fall through there, `jev-1.13.0` would be priced at default
 *  (sonnet-like) weights and over-report this run's spend by a factor of ~71. */
export const JEV_INPUT_USD_PER_MTOK = 0.042;

export function jevPriceUsd(spend: Spend): number {
  return (spend.input * JEV_INPUT_USD_PER_MTOK) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

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
      return jevBackend(jevSend(apiKey), options);
    },
  };
}

/** The backend itself, over an injected transport. */
export function jevBackend<F extends EvalFixtureBase>(
  send: JevSend,
  options: JevBackendOptions<F>,
): Backend<F> {
  return {
    trial: async (fixture, prompt, run, spend) => {
      const { state, questions } = options.ask(fixture, prompt, run);
      const response = await send({ model: run.model, state, questions });
      addUsage(spend, { usage: response.usage });
      const answers = response.answers ?? {};
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
        detail: answers,
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
        JevChoiceAnswer | undefined;
      if (typeof answer?.choice !== "string" || typeof answer.confidence !== "number") continue;
      trials.push({
        choice: answer.choice,
        confidence: answer.confidence,
        expected: r.expected,
        fixture: r.id,
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

if (import.meta.main) {
  // `bun run scripts/eval-jev.ts <report.json> [questionId] [--all]` — replays a completed run's
  // recorded distributions. Reads a file; makes no calls and needs no key.
  const [path, questionId = "kind"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (path === undefined) {
    console.error("usage: bun run scripts/eval-jev.ts <report.json> [questionId] [--all]");
    process.exit(2);
  }
  const report: unknown = await Bun.file(path).json();
  const trials = sweepTrialsFrom(report, questionId, !process.argv.includes("--all"));
  if (trials.length === 0) {
    console.error(`no sweepable trials in ${path} for question "${questionId}"`);
    process.exit(3);
  }
  console.log(formatSweep(sweepThreshold(trials, "unknown"), "unknown"));
}
