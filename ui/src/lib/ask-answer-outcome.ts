// What answering a session question (#3165) ended in, told apart for the operator (#4219): a
// confirmed delivery, a delivery whose outcome is unknown, a stale question, or a refusal. Every
// non-confirmed outcome carries a short ref that matches the server's `[ask] answer req=…` log line.
// Nothing here resubmits: an unknown outcome is the operator's to check in the terminal.

import { ApiError } from "#lib/api.js";
import { m } from "#lib/paraglide/messages.js";
import type { AnswerAskResult } from "#lib/types.js";

/** A failed answer request, by what the operator should do next. */
export type AskFailure =
  /** 409 ask_not_open — no open dialog with that id; nothing was typed. */
  | "stale"
  /** 409 ask_in_flight — another answer for this session is being typed. */
  | "in_flight"
  /** 409 ask_interrupted — typing stopped after some keys landed; what arrived is unknown. */
  | "interrupted"
  /** 400 — the answers no longer fit the questions. */
  | "invalid"
  /** 404 — the session is gone. */
  | "gone"
  /** Any other 4xx — refused before typing. */
  | "refused"
  /** Network failure, dropped connection, 5xx, unreachable machine — the outcome is unknown. */
  | "unknown";

export type AskOutcome = AnswerAskResult | AskFailure;

const CONFLICTS: Record<string, AskFailure> = {
  ask_not_open: "stale",
  ask_in_flight: "in_flight",
  ask_interrupted: "interrupted",
};

/** Map whatever `answerAsk` threw onto an {@link AskFailure}. Anything that is not an HTTP answer
 *  the server gave (a fetch TypeError, a severed socket) may have reached it, so it is `unknown`. */
export function classifyAskFailure(e: unknown): AskFailure {
  if (!(e instanceof ApiError)) return "unknown";
  if (e.status >= 500) return "unknown";
  if (e.status === 409) {
    // An older server sends the code only as `error`, which becomes the message.
    const code = e.code ?? (e.serverAuthored ? e.message : "");
    return CONFLICTS[code] ?? "refused";
  }
  if (e.status === 400) return "invalid";
  if (e.status === 404) return "gone";
  return e.status >= 400 ? "refused" : "unknown";
}

/** A short random correlation ref. `getRandomValues`, not `randomUUID`: the latter is missing
 *  outside secure contexts (plain-http LAN access). */
export function newAskRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The operator-facing text for an outcome; every non-delivered one ends with its ref. */
export function askOutcomeText(outcome: AskOutcome, ref: string): string {
  if (outcome === "verified") return m.ask_result_verified();
  const text = {
    mismatch: m.ask_result_mismatch,
    unverified: m.ask_result_unverified,
    stale: m.ask_result_stale,
    in_flight: m.ask_result_in_flight,
    interrupted: m.ask_result_interrupted,
    invalid: m.ask_result_invalid,
    gone: m.ask_result_gone,
    refused: m.ask_result_refused,
    unknown: m.ask_result_unknown,
  }[outcome]();
  return `${text} ${m.ask_result_ref({ ref })}`;
}
