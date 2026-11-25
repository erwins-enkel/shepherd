/**
 * The judge leg of New Task prompt coaching (#4177): one HTTP request asking whether the typed
 * prompt prescribes a fix before stating the problem. FAIL-OPEN: over the daily ceiling, transport
 * error, deadline or an unusable answer all mean "no hint" — the hint is optional coaching, and
 * Shape's own verdict covers the no-judge case.
 */
import type { Judge } from "./judge";
import type { JudgeSpendLedger } from "./judge-spend";
import {
  PRESCRIBING_QUESTION,
  interpretPrescribing,
  promptHintState,
  type PromptHint,
} from "./prompt-coach-core";

export async function promptHintViaJudge(
  prompt: string,
  judge: Judge,
  spend: Pick<JudgeSpendLedger, "allow" | "record"> | null,
  warn: (message: string, err: unknown) => void = (message, err) => console.warn(message, err),
): Promise<PromptHint | null> {
  const state = promptHintState(prompt);
  if (state === null) return null;
  try {
    if (spend && !spend.allow()) return null;
    const result = await judge.ask(state, { prescribing: PRESCRIBING_QUESTION });
    try {
      spend?.record(result.costUsd);
    } catch (err) {
      warn("[prompt-coach] judge spend record failed:", err);
    }
    return interpretPrescribing(result.answers.prescribing);
  } catch (err) {
    warn("[prompt-coach] judge failed (no hint):", err);
    return null;
  }
}
