/**
 * New Task prompt coaching (#4177) — the ONE definition of what the judge is asked about a typed
 * task prompt, so an eval added later measures the thing shipped.
 *
 * LEAF MODULE: types-only imports, no I/O. The question is a single bare `noul` — no `criteria`:
 * #2535 measured a criteria-listing variant separating worse than the bare instruction. The answer
 * is only ever used through {@link interpretPrescribing}, which applies {@link PRESCRIBING_AT}.
 */
import type { JudgeNoulQuestion } from "./judge";

/** `p` at or above this ⇒ the hint shows. Uncalibrated (no eval yet) and deliberately high: the
 *  hint is passive coaching, so a false one is noise and a missed one costs nothing. */
export const PRESCRIBING_AT = 0.7;

/** Shorter prompts carry too little to judge; the judge is not asked at all. */
export const HINT_MIN_CHARS = 40;

const PROMPT_CLIP = 4000;

export type PromptHint = "prescribing";

export const PRESCRIBING_QUESTION: JudgeNoulQuestion = {
  type: "noul",
  instructions:
    "This task prompt names a specific fix (a file, function or mechanism to change) before it states the problem it solves.",
};

/** The state blob: the trimmed prompt, clipped; null when it is too short to ask about. */
export function promptHintState(prompt: string): string | null {
  const t = prompt.trim();
  if (t.length < HINT_MIN_CHARS) return null;
  return `Task prompt:\n${t.slice(0, PROMPT_CLIP)}`;
}

/** A missing, off-shape or out-of-range answer reads as no hint. */
export function interpretPrescribing(
  answer: { type?: string; p?: unknown } | undefined,
): PromptHint | null {
  if (!answer || answer.type !== "noul") return null;
  const p = answer.p;
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) return null;
  return p >= PRESCRIBING_AT ? "prescribing" : null;
}
