/**
 * The `Judge` seam — Shepherd's interface to a "System One" decision model (issue #2369).
 *
 * WHY THIS IS SHAPED LIKE THIS. The interface is written around the PRIMITIVES a decision model
 * offers — pick one of N (`choice`), a yes/no judgement (`noul`) — and deliberately NOT around any
 * one vendor's HTTP API. The vendor this ships against is a closed early-access service with a
 * single model, no self-host and no open weights; at least one Apache-2.0 implementation already
 * speaks the same wire format. A seam expressed in primitives is vendor-neutral at no extra cost
 * and survives the vendor being rate-limited, repriced, acquired or shut down.
 *
 * TWO CONTRACTS THIS FILE EXISTS TO ENFORCE, both of which are easy to get wrong once and then
 * inherit forever:
 *
 *  1. **Raw probabilities cross the seam; a vendor `confidence` scalar does not.** Every open
 *     implementation of this wire format defines `confidence` as normalised entropy
 *     (`1 - H(p)/log K`), which is NOT what the current vendor's field means. A seam that passes
 *     the scalar through would therefore keep type-checking and start lying the moment the backend
 *     changes. {@link JudgeChoiceAnswer.probabilities} is the durable quantity; `vendorConfidence`
 *     is carried beside it, named so no call site can mistake it for a portable one.
 *
 *  2. **A choice and a noul share no arithmetic.** They may ride the same request, but a threshold
 *     tuned on one says nothing about the other: a choice is RELATIVE (which option won) while a
 *     noul is ABSOLUTE (and can legitimately be low for every question asked). The two answer types
 *     below are therefore disjoint, and {@link JudgeNoulAnswer} has no confidence field at all —
 *     the vendor reports none for a noul, and synthesising one (`|p - 0.5| * 2` is the usual
 *     invention) manufactures a number nothing calibrated.
 *
 * Nothing here talks to a network. `src/judge-typesafe.ts` is the only implementation today.
 */

/** Pick exactly one of the named options. `criteria` maps each option to a description, or to
 *  `null` when the `state` already defines the options and repeating them would say it twice. */
export interface JudgeChoiceQuestion<L extends string = string> {
  type: "choice";
  instructions: string;
  criteria: Readonly<Record<L, string | null>>;
}

/** A yes/no judgement. Answered as a probability, never as a boolean — see contract 2 above. */
export interface JudgeNoulQuestion {
  type: "noul";
  instructions: string;
}

export type JudgeQuestion = JudgeChoiceQuestion | JudgeNoulQuestion;

export interface JudgeChoiceAnswer<L extends string = string> {
  type: "choice";
  /** The winning option. Constrained to the option set by the decoder — it cannot come back off-enum. */
  choice: L;
  /** The full distribution. THIS is what a gate derives from; it is the quantity that means the
   *  same thing across implementations. */
  probabilities: Readonly<Record<string, number>>;
  /** The vendor's own scalar, definition unspecified and NOT comparable across implementations.
   *  Kept for logging and offline analysis. Never gate on it. */
  vendorConfidence: number;
}

/** No confidence field, deliberately — see contract 2. A gate over a noul is `p >= t` with a
 *  threshold chosen for that question alone. */
export interface JudgeNoulAnswer {
  type: "noul";
  /** Probability of "yes", 0–1. */
  p: number;
}

export type JudgeAnswer = JudgeChoiceAnswer | JudgeNoulAnswer;

/** The answer a given question shape produces, so a caller's question map types its own answers. */
export type JudgeAnswerFor<Q extends JudgeQuestion> =
  Q extends JudgeChoiceQuestion<infer L>
    ? JudgeChoiceAnswer<L>
    : Q extends JudgeNoulQuestion
      ? JudgeNoulAnswer
      : never;

export interface JudgeResult<Q extends Record<string, JudgeQuestion>> {
  answers: { [K in keyof Q]: JudgeAnswerFor<Q[K]> };
  /** The model that answered, as the backend reported it — not as we asked for it. Logged so a
   *  silent vendor re-point is visible after the fact. */
  model: string;
  /** Billed input tokens. Output is not billed by the current vendor and is reported for completeness. */
  usage: { inputTokens: number; outputTokens: number };
  /** What this call cost, in USD, priced by the backend that made it. */
  costUsd: number;
}

/**
 * Ask a set of named questions against one shared `state` blob.
 *
 * `state` is `unknown` because the wire format accepts text or JSON. Callers pass whichever shape
 * MEASURED better for their decision — for the stop classifier that is the production prompt
 * verbatim, which beat a purpose-authored structured state.
 *
 * Throws {@link JudgeError} for every failure. Callers are expected to have a non-model fallback;
 * a judge is an optimisation over an existing correct path, never the only way to get an answer.
 */
export interface Judge {
  ask<const Q extends Record<string, JudgeQuestion>>(
    state: unknown,
    questions: Q,
  ): Promise<JudgeResult<Q>>;
}

/**
 * Every failure the seam surfaces, with the transport's status preserved in `message`.
 *
 * The status is IN THE MESSAGE, verbatim and first, because the eval harness classifies transport
 * failures by matching the text (`scripts/eval-core.ts` → `isPermanent` / `isCannotRun`): a 401
 * must fail the whole run fast rather than burn the backoff once per trial, while a 429 must read
 * as "the account cannot call right now" rather than as a prompt regression.
 */
export class JudgeError extends Error {
  constructor(
    message: string,
    /** HTTP status when the failure carried one; absent for connection/timeout/abort failures. */
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "JudgeError";
  }
}
