import { test, expect } from "bun:test";
import {
  JudgeError,
  type JudgeAnswerFor,
  type JudgeChoiceAnswer,
  type JudgeChoiceQuestion,
  type JudgeNoulAnswer,
  type JudgeNoulQuestion,
} from "../src/judge";

// The seam has almost no runtime: it is a set of contracts. Most of this file is therefore
// type-level, and it is deliberately so — the contracts it pins are ones you only get wrong once,
// and then inherit forever in every call site built on top.

test("JudgeError leads with the HTTP status, because that is what the eval harness matches on", () => {
  const err = new JudgeError("judge: 401 authentication_error", 401);
  expect(err.name).toBe("JudgeError");
  expect(err.status).toBe(401);
  // `scripts/eval-core.ts`'s isPermanent/isCannotRun read the MESSAGE, not the field — a bad key
  // has to fail the whole run fast rather than burn the backoff once per trial.
  expect(err.message).toMatch(/\b401\b/);
});

test("a failure with no HTTP status (connection, timeout, abort) carries none rather than a fake one", () => {
  const err = new JudgeError("judge: aborted at the 8000ms deadline");
  expect(err.status).toBeUndefined();
});

test("the cause chain is preserved, so a transport failure stays diagnosable", () => {
  const cause = new Error("socket hang up");
  expect(new JudgeError("judge: socket hang up", undefined, { cause }).cause).toBe(cause);
});

// ── the two contracts, enforced by the type system ──────────────────────────────

test("a noul answer carries NO confidence, and a choice threshold cannot be applied to one", () => {
  const noul: JudgeNoulAnswer = { type: "noul", p: 0.22 };

  // @ts-expect-error a noul has no `confidence` — the vendor reports none, and synthesising one
  // (the usual invention is `|p - 0.5| * 2`) manufactures a number nothing calibrated.
  void noul.confidence;

  // @ts-expect-error nor does it carry a distribution to derive a gate from.
  void noul.probabilities;

  // A choice and a noul share no arithmetic: they may ride the same request, but a threshold tuned
  // on one says nothing about the other (a choice is relative, a noul absolute). The types are
  // disjoint so a gate written for one cannot silently be handed the other.
  const gateOnChoice = (a: JudgeChoiceAnswer, t: number): boolean =>
    (a.probabilities[a.choice] ?? 0) >= t;
  // @ts-expect-error a noul answer is not a choice answer.
  void (() => gateOnChoice(noul, 0.6));

  expect(noul.p).toBe(0.22);
});

test("a choice question's option labels type its answer, so an off-enum branch cannot be written", () => {
  type Kind = "gate" | "unknown";
  type Question = JudgeChoiceQuestion<Kind>;
  type Answer = JudgeAnswerFor<Question>;
  const answer: Answer = {
    type: "choice",
    choice: "gate",
    probabilities: { gate: 0.9, unknown: 0.1 },
    vendorConfidence: 0.64,
  };

  // @ts-expect-error "finished" is not one of the options this question offered.
  const bad: Answer["choice"] = "finished";
  void bad;

  expect(answer.choice).toBe("gate");
  // The raw distribution is what crosses the seam. `vendorConfidence` is present but named so no
  // call site can mistake it for a portable quantity — every open implementation of this wire
  // format defines it as normalised entropy, which is not what the current vendor means by it.
  expect(answer.probabilities.gate).toBe(0.9);
});

test("a noul question answers to a noul, not to a choice — the mapping is by question shape", () => {
  type Answer = JudgeAnswerFor<JudgeNoulQuestion>;
  const answer: Answer = { type: "noul", p: 0.81 };
  expect(answer.type).toBe("noul");
});
