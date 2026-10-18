// Answers an open AskUserQuestion dialog from the native panel by typing it (issue #3165).
//
// The panel's answers are resolved against the HOOKED questions (never against client-sent ones),
// typed into the pane one key per write, then verified against PostToolUse's
// `tool_response.answers` for the same tool_use_id. There is no automatic retry: a mismatch is
// reported to the caller (and logged as a key-sequence/version drift diagnostic), and the operator
// finishes in the terminal.

import {
  ASK_KEY_GAP_MS,
  askAnswersMatch,
  askKeySequence,
  expectedAskAnswers,
  resolveAskAnswers,
  type AskAnswerResult,
  type PendingAsk,
} from "./ask-user-question";
import type { RawAnswer } from "./plan-gate";

export interface AskAnswerDeps {
  /** The ask the session's announced block carries right now (poller.currentAsk). */
  currentAsk: (id: string) => PendingAsk | null;
  /** SessionService.typeKeys. */
  typeKeys: (
    id: string,
    writes: string[],
    gapMs: number,
    stillValid: () => boolean,
  ) => Promise<boolean>;
  /** How long to wait for the verifying PostToolUse. */
  verifyTimeoutMs?: number;
  gapMs?: number;
}

export type AnswerAskOutcome =
  | { ok: true; result: AskAnswerResult }
  | { ok: false; status: 400 | 409; error: string };

interface Waiter {
  toolUseId: string;
  resolve: (answers: Record<string, string> | null) => void;
}

export class AskAnswerService {
  /** Sessions with a sequence in flight (typing or awaiting verification). */
  #inflight = new Set<string>();
  #waiters = new Map<string, Waiter>();

  constructor(private deps: AskAnswerDeps) {}

  async answer(id: string, toolUseId: string, raw: RawAnswer[]): Promise<AnswerAskOutcome> {
    if (this.#inflight.has(id)) return { ok: false, status: 409, error: "ask_in_flight" };
    const ask = this.deps.currentAsk(id);
    if (!ask || ask.toolUseId !== toolUseId) {
      return { ok: false, status: 409, error: "ask_not_open" };
    }
    const resolved = resolveAskAnswers(ask.questions, raw);
    if (!resolved) return { ok: false, status: 400, error: "invalid answers" };
    const keys = askKeySequence(resolved);
    const expected = expectedAskAnswers(resolved);

    this.#inflight.add(id);
    try {
      // Registered BEFORE typing: the PostToolUse can arrive the moment the last key lands.
      const verdict = this.#awaitPostToolUse(id, toolUseId);
      const typed = await this.deps.typeKeys(
        id,
        keys,
        this.deps.gapMs ?? ASK_KEY_GAP_MS,
        () => this.deps.currentAsk(id)?.toolUseId === toolUseId,
      );
      if (!typed) {
        this.#waiters.delete(id);
        return { ok: false, status: 409, error: "ask_not_open" };
      }
      const actual = await verdict;
      if (actual === null) return { ok: true, result: "unverified" };
      if (askAnswersMatch(expected, actual)) return { ok: true, result: "verified" };
      console.warn(`[ask] answer mismatch session=${id} tool_use=${toolUseId}`, {
        expected,
        actual,
      });
      return { ok: true, result: "mismatch" };
    } finally {
      this.#inflight.delete(id);
    }
  }

  /** Fed by the hook sink for every PostToolUse(/Failure) carrying a tool_use_id. */
  onPostToolUse(id: string, toolUseId: string, answers: Record<string, string> | null): void {
    const w = this.#waiters.get(id);
    if (!w || w.toolUseId !== toolUseId) return;
    this.#waiters.delete(id);
    w.resolve(answers);
  }

  #awaitPostToolUse(id: string, toolUseId: string): Promise<Record<string, string> | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.#waiters.get(id)?.toolUseId === toolUseId) this.#waiters.delete(id);
        resolve(null);
      }, this.deps.verifyTimeoutMs ?? 10_000);
      this.#waiters.set(id, {
        toolUseId,
        resolve: (answers) => {
          clearTimeout(timer);
          resolve(answers);
        },
      });
    });
  }
}
