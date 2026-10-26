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
  let last: TranscriptRecord | null = null;
  for (const o of eachJsonlObject(jsonl)) {
    const rec = o as TranscriptRecord | null;
    if (!rec || rec.isSidechain === true) continue;
    if (rec.type === "assistant" || rec.type === "user") last = rec;
  }
  if (
    last?.type === "assistant" &&
    last.isApiErrorMessage === true &&
    last.error === "server_error" &&
    typeof last.uuid === "string"
  )
    return { uuid: last.uuid };
  return null;
}
