/**
 * Per-transport failure record for a `gh`-backed listing.
 *
 * `GithubForge.listIssues` draws on two INDEPENDENT GitHub budgets (`gh issue list`
 * on the GraphQL bucket, `gh api` on the REST bucket) and falls back between them.
 * When the listing fails, the operator sees only "couldn't load issues" — which
 * transport was tried, and why each one gave up, dies in the forge. These helpers
 * carry that trail out on the thrown error so `/api/issues` can report it and the
 * UI's retry state can name the paths instead of guessing at a rate limit.
 */

import { isRateLimitError } from "./rate-limit";

/** Which `gh` transport produced the failure. */
export type GhTransport = "cli" | "rest";

/** Classified cause of one failed transport. `http` is the catch-all for a status
 *  we don't name specially; `unknown` for output that carries no status at all. */
export type GhFailureReason =
  "rate_limit" | "auth" | "not_found" | "gh_missing" | "network" | "http" | "unknown";

/** One executed-and-failed transport, as reported to the UI. */
export interface GhFetchAttempt {
  transport: GhTransport;
  reason: GhFailureReason;
  /** HTTP status when `gh` reported one (`(HTTP 403)`); absent otherwise. */
  status?: number;
  /** Sanitized `gh` output for the UI's hover tooltip. May be empty. */
  detail: string;
}

/** Cap on `detail`: enough for a full `gh` error line, short of pasting a stack. */
const DETAIL_MAX = 300;

/**
 * Credential shapes that can ride along in `gh`/git diagnostics. This text is newly
 * leaving the server for the browser, so redact before it travels rather than
 * trusting `gh` to keep quiet about what it echoes.
 *
 * The label-preserving rules come first: a header or a remote URL keeps its shape
 * (so the message still reads as a diagnosis) while its secret half goes. Token
 * literals are matched last, catching anything the shaped rules didn't frame.
 *
 * Deliberately NOT matched: a bare 40-hex string. That is the shape of a legacy
 * OAuth token AND of every git SHA in the output — redacting it would gut the
 * diagnosis to cover a token type GitHub deprecated in 2021.
 */
const REDACTIONS: Array<[RegExp, string]> = [
  // `Authorization: token …` / `Bearer …` — gh prints request headers under GH_DEBUG=api.
  [/\b(authorization\s*:\s*)[^\s,;]+(?:\s+[^\s,;]+)?/gi, "$1<redacted>"],
  // Credentials in a remote URL: https://user:pat@github.com/… (also x-access-token:…).
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1<redacted>@"],
  // Token-carrying env assignments echoed back in an error line.
  [/\b((?:GH|GITHUB)(?:_ENTERPRISE)?_TOKEN\s*=\s*)[^\s]+/g, "$1<redacted>"],
  // GitHub App / installation JWTs (header.payload.signature).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<redacted>"],
  // gh token literals: ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained PATs.
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "<redacted>"],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, "<redacted>"],
];

// eslint-disable-next-line no-control-regex -- stripping ANSI SGR sequences requires \x1b
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Raw text of a `gh` failure: execFile rejections carry stderr, everything else
 *  falls back to the message. */
function errorText(err: unknown): string {
  const e = err as Record<string, unknown> | null | undefined;
  const stderr = typeof e?.stderr === "string" ? e.stderr : "";
  const message = typeof e?.message === "string" ? e.message : "";
  return stderr.trim() || message.trim() || String(err ?? "").trim();
}

/** ANSI-free, single-line, credential-redacted, length-capped view of a `gh` failure.
 *  Redaction runs BEFORE the cap so a secret can never survive as a truncated head. */
export function sanitizeDetail(raw: string): string {
  let out = raw.replace(ANSI, "").replace(/\s+/g, " ").trim();
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out.length > DETAIL_MAX ? `${out.slice(0, DETAIL_MAX - 1)}…` : out;
}

/** First HTTP status `gh` names in its output (`(HTTP 403)`, `HTTP 404:`). */
function httpStatus(text: string): number | undefined {
  const m = /\bHTTP (\d{3})\b/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

function reasonFor(err: unknown, text: string, status: number | undefined): GhFailureReason {
  // Binary missing beats every text heuristic — the subprocess never ran, so any
  // HTTP-looking text would be from somewhere else entirely.
  if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return "gh_missing";
  // Before the status check: GitHub answers a drained budget with 403, which would
  // otherwise be reported as a bare permission error.
  if (isRateLimitError(err)) return "rate_limit";
  if (status === 401) return "auth";
  if (status === 404) return "not_found";
  if (/bad credentials|gh auth login|not logged in|authentication/i.test(text)) return "auth";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(text)) return "network";
  if (status !== undefined) return "http";
  return "unknown";
}

/** Classify one failed transport for display. */
export function classifyGhError(transport: GhTransport, err: unknown): GhFetchAttempt {
  const text = errorText(err);
  const status = httpStatus(text);
  const reason = reasonFor(err, text, status);
  return {
    transport,
    reason,
    // Only carry a status where it adds something the reason doesn't already say.
    ...(status !== undefined && reason !== "gh_missing" ? { status } : {}),
    detail: sanitizeDetail(text),
  };
}

/** Symbol key so the trail never shows up in `JSON.stringify(err)`, a log line, or
 *  an equality check on the error's own enumerable properties. */
const ATTEMPTS = Symbol.for("shepherd.gh.attempts");

/** Attach a transport trail to an error on its way out of the forge. Returns the
 *  same error (a non-object throw is wrapped, since a symbol can't ride a string). */
export function attachAttempts(err: unknown, attempts: GhFetchAttempt[]): unknown {
  const target = typeof err === "object" && err !== null ? err : new Error(String(err));
  Object.defineProperty(target, ATTEMPTS, {
    value: attempts,
    enumerable: false,
    configurable: true,
  });
  return target;
}

/** Read a transport trail off an error, or null when it carries none (every non-`gh`
 *  forge, and any failure raised outside the listing itself). */
export function attemptsOf(err: unknown): GhFetchAttempt[] | null {
  if (typeof err !== "object" || err === null) return null;
  const v = (err as Record<symbol, unknown>)[ATTEMPTS];
  return Array.isArray(v) && v.length > 0 ? (v as GhFetchAttempt[]) : null;
}
