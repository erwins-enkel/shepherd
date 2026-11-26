import { eachJsonlObject } from "./jsonl";

/** Agent-facing retry steer. NOT UI chrome — never i18n'd (typed into an English Claude Code
 *  pane). Its opening words are the `api_retry` prefix in src/steer-log.ts. */
export const API_RETRY_STEER =
  "⟳ Your last response was cut off by a transient API error. Continue exactly where you left off.";

interface TranscriptRecord {
  type?: unknown;
  uuid?: unknown;
  isSidechain?: unknown;
  isApiErrorMessage?: unknown;
  error?: unknown;
}

/**
 * The transient API error a Claude turn died on, or null. Transient = the LAST conversational
 * record (assistant/user, main chain) is Claude Code's synthetic `isApiErrorMessage` record with
 * `error: "server_error"` — a stream cut ("Connection lost mid-response") or a 5xx/529 that
 * outlived CC's own retries. Auth, rate-limit/usage and invalid-request errors carry other `error`
 * values and stay with their own flows. Non-conversational records CC appends after the error
 * (system turn_duration, api-request blobs, …) are skipped. `uuid` keys the error episode.
 */
export function transientApiError(jsonl: string): { uuid: string } | null {
  return lastApiError(jsonl, "server_error");
}

/**
 * The authentication failure a Claude turn died on, or null: the last conversational record is
 * the synthetic `isApiErrorMessage` record with `error: "authentication_failed"` ("OAuth token
 * revoked · Please run /login", "Login expired", …). Retrying cannot fix it (#4260).
 */
export function authApiError(jsonl: string): { uuid: string } | null {
  return lastApiError(jsonl, "authentication_failed");
}

/** The last main-chain conversational record, when it is an API error of `kind`. */
function lastApiError(jsonl: string, kind: string): { uuid: string } | null {
  let last: TranscriptRecord | null = null;
  for (const o of eachJsonlObject(jsonl)) {
    const rec = o as TranscriptRecord | null;
    if (!rec || rec.isSidechain === true) continue;
    if (rec.type === "assistant" || rec.type === "user") last = rec;
  }
  if (
    last?.type === "assistant" &&
    last.isApiErrorMessage === true &&
    last.error === kind &&
    typeof last.uuid === "string"
  )
    return { uuid: last.uuid };
  return null;
}
