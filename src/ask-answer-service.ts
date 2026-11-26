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
  codex?: {
    isSession: (id: string) => boolean;
    answer: (id: string, toolUseId: string, raw: RawAnswer[]) => Promise<AnswerAskOutcome>;
  };
  /** The ask the session's announced block carries right now (poller.currentAsk). */
  currentAsk: (id: string) => PendingAsk | null;
  /** Still open per the hooks (poller.askStillOpen) — checked before every typed key. */
  askStillOpen: (id: string, toolUseId: string) => boolean;
  /** poller.holdAsk (#4219): keep the ask open across a block clear while typing; returns release. */
  holdAsk?: (id: string, toolUseId: string) => () => void;
  /** SessionService.typeKeys — resolves to how many writes were sent. */
  typeKeys: (
    id: string,
    writes: string[],
    gapMs: number,
    stillValid: () => boolean,
  ) => Promise<number>;
  /** How long to wait for the verifying PostToolUse. */
  verifyTimeoutMs?: number;
  gapMs?: number;
}

/** 409 codes: `ask_not_open` — nothing was typed; `ask_in_flight` — another answer is being typed;
 *  `ask_interrupted` — typing stopped after some keys reached the pane, so the outcome is unknown. */
export type AnswerAskOutcome =
  { ok: true; result: AskAnswerResult } | { ok: false; status: 400 | 409; error: string };

/** Per-request facts for the single redacted log line (#4219) — ids, counts, never answer text. */
interface AnswerTrace {
  provider: "claude" | "codex";
  keys?: { sent: number; total: number };
}

interface Waiter {
  toolUseId: string;
  resolve: (answers: Record<string, string> | null) => void;
}

export class AskAnswerService {
  /** Sessions with a sequence in flight (typing or awaiting verification). */
  #inflight = new Set<string>();
  #waiters = new Map<string, Waiter>();

  constructor(private deps: AskAnswerDeps) {}

  /** `requestId` is the client's correlation ref (already sanitized by the route), logged only. */
  async answer(
    id: string,
    toolUseId: string,
    raw: RawAnswer[],
    requestId = "-",
  ): Promise<AnswerAskOutcome> {
    const started = Date.now();
    const trace: AnswerTrace = { provider: this.deps.codex?.isSession(id) ? "codex" : "claude" };
    let out: AnswerAskOutcome | undefined;
    try {
      out = await this.#answer(id, toolUseId, raw, trace);
      return out;
    } finally {
      logAnswer({ requestId, id, toolUseId, trace, out, ms: Date.now() - started });
    }
  }

  async #answer(
    id: string,
    toolUseId: string,
    raw: RawAnswer[],
    trace: AnswerTrace,
  ): Promise<AnswerAskOutcome> {
    if (this.#inflight.has(id)) return { ok: false, status: 409, error: "ask_in_flight" };
    if (trace.provider === "codex" && this.deps.codex) {
      this.#inflight.add(id);
      try {
        return await this.deps.codex.answer(id, toolUseId, raw);
      } finally {
        this.#inflight.delete(id);
      }
    }
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
      const sent = await this.#type(id, toolUseId, keys);
      trace.keys = { sent, total: keys.length };
      if (sent < keys.length) {
        this.#waiters.delete(id);
        return { ok: false, status: 409, error: sent > 0 ? "ask_interrupted" : "ask_not_open" };
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

  /** Type under the poller's ask hold (#4219), so a redraw-induced block clear can't cut it short. */
  async #type(id: string, toolUseId: string, keys: string[]): Promise<number> {
    const release = this.deps.holdAsk?.(id, toolUseId);
    try {
      return await this.deps.typeKeys(id, keys, this.deps.gapMs ?? ASK_KEY_GAP_MS, () =>
        this.deps.askStillOpen(id, toolUseId),
      );
    } finally {
      release?.();
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

/** One line per answer request (#4219): the client's ref joins a toast to this line. Ids and counts
 *  only — question and answer text never reach it. A throw (no `out`) logs as `error`. */
function logAnswer(e: {
  requestId: string;
  id: string;
  toolUseId: string;
  trace: AnswerTrace;
  out: AnswerAskOutcome | undefined;
  ms: number;
}): void {
  const outcome = !e.out
    ? "error"
    : e.out.ok
      ? e.out.result
      : e.out.status === 400
        ? "invalid"
        : e.out.error;
  const keys = e.trace.keys ? ` keys=${e.trace.keys.sent}/${e.trace.keys.total}` : "";
  const line =
    `[ask] answer req=${e.requestId} session=${logSafe(e.id)} tool_use=${logSafe(e.toolUseId)} ` +
    `provider=${e.trace.provider} outcome=${outcome}${keys} ms=${e.ms}`;
  if (outcome === "verified") console.info(line);
  else console.warn(line);
}

/** Client-supplied ids go into a log line: keep them to one bounded token. */
const logSafe = (v: string): string => v.replace(/[^\w.:-]/g, "?").slice(0, 80);
