/**
 * The {@link Judge} implementation backed by TypeSafe AI's official SDK (issue #2369).
 *
 * WHY THE SDK AND NOT A HAND-ROLLED `fetch`. The spike that measured this decision
 * (`scripts/eval-jev.ts`, #2364) posted to the endpoint directly, which is the right shape for a
 * one-shot eval and the wrong one for a path that runs on every agent stop: the SDK retries with
 * backoff and honours `Retry-After`, and the vendor's own models page warns that rate limits can
 * change without notice while they absorb demand. A hand-rolled transport meets a 429 by failing.
 * `@typesafe-ai/sdk` has ZERO runtime dependencies, which is what makes it admissible against a
 * root that has three.
 *
 * AND WHY WE STILL BOUND IT. Read off the SDK's shipped type declarations rather than its prose
 * docs: its `timeout` is PER ATTEMPT and there is no total retry budget (the declarations say so
 * twice). With retries on 408/429/5xx and a server `Retry-After` honoured up to a full minute, a
 * single rate-limited call left at defaults can outlast the 120 s `claude` spawn this exists to be
 * faster than — the exact inversion the feature is for. Every call therefore runs under an
 * `AbortSignal` carrying a TOTAL wall-clock deadline, with a per-attempt timeout inside it.
 * Exceeding the deadline aborts and lets the caller fall back to the spawn, which is the correct
 * trade: waiting out a rate limit on this path is worse than paying for the spawn.
 */

import {
  APIError,
  APIUserAbortError,
  TypeSafeClient,
  choice as sdkChoice,
  noul as sdkNoul,
  type ChoiceResponse,
  type Fetch,
  type NoulResponse,
  type Question as SdkQuestion,
  type Questions as SdkQuestions,
} from "@typesafe-ai/sdk";
import {
  JudgeError,
  type Judge,
  type JudgeAnswer,
  type JudgeQuestion,
  type JudgeResult,
} from "./judge";

/**
 * $/Mtok of INPUT. Output is not billed by this vendor.
 *
 * `src/pricing.ts` deliberately does not learn this model. Its table is real Anthropic list prices
 * feeding the usage lens's weighted units, and a non-Anthropic row there would both mis-denominate
 * the lens (metered dollars summed into list-price-equivalent units for subscription work) and,
 * left to fall through, price this model at default sonnet-like weights — overstating it by nearly
 * two orders of magnitude.
 */
export const JUDGE_INPUT_USD_PER_MTOK = 0.042;

export function judgeCostUsd(inputTokens: number): number {
  return (inputTokens * JUDGE_INPUT_USD_PER_MTOK) / 1_000_000;
}

export interface TypeSafeJudgeOptions {
  apiKey: string;
  /** API root. Configuration rather than a constant: an Apache-2.0 implementation speaks this wire
   *  format today, and this is the entire cost of keeping the vendor-swap door open. */
  baseUrl: string;
  /** A PINNED snapshot, never a floating alias — under an alias a vendor re-point would arrive as a
   *  silent accuracy change. The SDK's own default is the floating alias, so this is always passed. */
  model: string;
  /** Total wall-clock budget for one `ask`, retries included. */
  deadlineMs: number;
  /** Injected so tests drive the REAL SDK — its retry policy, error classes and parsing — with no
   *  network and no key. */
  fetch?: Fetch;
}

/** Per-attempt budget, derived from the total so the two can never be configured into conflict.
 *  Three attempts is the SDK's default (initial + 2 retries); leaving headroom for its backoff is
 *  what makes the deadline the binding constraint rather than a race between the two timers. */
function attemptTimeoutMs(deadlineMs: number): number {
  return Math.max(1_000, Math.floor(deadlineMs / 3));
}

function toSdkQuestion(q: JudgeQuestion): SdkQuestion {
  // A noul's `criteria` is optional at the seam and optional in the SDK, so an absent one rides as
  // `undefined` and JSON-drops — a caller shipping a verbatim prompt gets the byte-identical
  // request it got before the field existed.
  return q.type === "choice"
    ? sdkChoice(q.instructions, q.criteria)
    : sdkNoul(q.instructions, q.criteria);
}

function fromSdkAnswer(name: string, answer: ChoiceResponse | NoulResponse): JudgeAnswer {
  if (answer.type === "choice") {
    return {
      type: "choice",
      choice: answer.choice,
      probabilities: answer.probabilities,
      vendorConfidence: answer.confidence,
    };
  }
  if (answer.type === "noul") return { type: "noul", p: answer.noul };
  // The decoder constrains the answer to the question's own shape, so this is unreachable against a
  // conforming backend — and reachable against a non-conforming one, which is exactly the case the
  // configurable base URL makes possible. Fail loudly rather than coerce.
  throw new JudgeError(`judge: answer "${name}" has an unrecognised type`);
}

/** Map the SDK's error classes onto one seam error whose message leads with the HTTP status. */
function toJudgeError(err: unknown, deadlineMs: number): JudgeError {
  if (err instanceof APIError) {
    const body = typeof err.body === "string" ? err.body : JSON.stringify(err.body ?? "");
    return new JudgeError(`judge: ${err.status} ${body.slice(0, 500)}`, err.status, { cause: err });
  }
  if (err instanceof APIUserAbortError) {
    return new JudgeError(`judge: aborted at the ${deadlineMs}ms deadline`, undefined, {
      cause: err,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new JudgeError(`judge: ${message}`, undefined, { cause: err });
}

export function createTypeSafeJudge(options: TypeSafeJudgeOptions): Judge {
  const client = new TypeSafeClient({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    defaultModel: options.model,
    timeout: attemptTimeoutMs(options.deadlineMs),
    // NEVER `debug`: at that level the SDK logs request bodies unredacted, and a body here carries
    // untrusted PTY output and the operator's task prompt.
    logLevel: "warn",
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    async ask(state, questions) {
      const sdkQuestions: SdkQuestions = {};
      for (const [name, q] of Object.entries(questions)) sdkQuestions[name] = toSdkQuestion(q);

      let result;
      try {
        result = await client.systemOne(
          { state: state as never, questions: sdkQuestions },
          { signal: AbortSignal.timeout(options.deadlineMs) },
        );
      } catch (err) {
        throw toJudgeError(err, options.deadlineMs);
      }

      const answers: Record<string, JudgeAnswer> = {};
      for (const name of Object.keys(questions)) {
        const answer = result.answers[name] as ChoiceResponse | NoulResponse | undefined;
        if (!answer) throw new JudgeError(`judge: no answer for "${name}"`);
        answers[name] = fromSdkAnswer(name, answer);
      }

      return {
        answers,
        model: result.model,
        usage: {
          inputTokens: result.usage?.input_tokens ?? 0,
          outputTokens: result.usage?.output_tokens ?? 0,
        },
        costUsd: judgeCostUsd(result.usage?.input_tokens ?? 0),
      } as JudgeResult<typeof questions>;
    },
  };
}
