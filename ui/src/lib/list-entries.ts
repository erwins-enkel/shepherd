// Client mirrors of the server's gates for the repo-config list fields. Keep each in sync with
// its server rule; test/list-entries-parity.test.ts runs both over the same inputs.
//  - browser hosts: the HOSTNAME_RE (src/egress.ts → normalizeHost, used by src/validate.ts →
//    validateHostList), plus the IP-literal refusal of validateBrowserAllowedHosts.
//  - egress entries: src/egress.ts → normalizeEgressEntry (`[*.]host[:port]`, `:443` dropped).
//  - priority labels: src/server.ts → parsePriorityLabels (trimmed, non-empty).
//  - review bots: src/server.ts → parseReviewFeedbackBots (normalizeBotLogin from
//    src/review-feedback-core.ts, then a GitHub login, at most 20).
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const IPV4_RE = /^\d+(\.\d+)+$/;
const EGRESS_ENTRY_RE = /^(\*\.)?([^:*]+)(?::([1-9]\d{0,4}))?$/;

/** The drain's built-in priority label (src/drain-core.ts → PRIORITY_LABEL); always active. */
export const PRIORITY_LABEL = "shepherd:priority";

/** One entry checked against the entries already listed: its normalized value, or why not. */
export type ListEntryCheck<R extends string> =
  { ok: true; value: string } | { ok: false; reason: R };

/** An autonomous Browser Attach allowlist entry (browserAllowedHosts). */
export function checkBrowserHost(
  raw: string,
  existing: readonly string[],
): ListEntryCheck<"empty" | "invalid" | "ip" | "duplicate"> {
  const host = raw.trim().toLowerCase();
  if (!host) return { ok: false, reason: "empty" };
  if (IPV4_RE.test(host)) return { ok: false, reason: "ip" };
  if (!HOSTNAME_RE.test(host)) return { ok: false, reason: "invalid" };
  if (existing.includes(host)) return { ok: false, reason: "duplicate" };
  return { ok: true, value: host };
}

/** An egress entry in its stored form, or null: `host` exactly, `*.host` its subdomains, each
 *  optionally `:port` (that port only; `:443` is the default and dropped). */
function normalizeEgressEntry(entry: string): string | null {
  const m = EGRESS_ENTRY_RE.exec(entry);
  if (!m) return null;
  const [, wildcard = "", host, portText] = m;
  if (!HOSTNAME_RE.test(host!)) return null;
  if (wildcard && IPV4_RE.test(host!)) return null;
  const port = portText === undefined ? 443 : Number(portText);
  if (port > 65535) return null;
  return port === 443 ? wildcard + host : `${wildcard}${host}:${port}`;
}

/** An extra egress-allowlist entry (egressExtraHosts). The server accepts a dotted-quad here. */
export function checkEgressHost(
  raw: string,
  existing: readonly string[],
): ListEntryCheck<"empty" | "invalid" | "duplicate"> {
  const entry = raw.trim().toLowerCase();
  if (!entry) return { ok: false, reason: "empty" };
  const value = normalizeEgressEntry(entry);
  if (value === null) return { ok: false, reason: "invalid" };
  if (existing.includes(value)) return { ok: false, reason: "duplicate" };
  return { ok: true, value };
}

/** A muted egress host (`[*.]host`, no port): mirrors src/egress-settings.ts → normalizeMutedEntry. */
export function checkMutedHost(
  raw: string,
  existing: readonly string[],
): ListEntryCheck<"empty" | "invalid" | "duplicate"> {
  if (raw.includes(":")) return { ok: false, reason: "invalid" };
  return checkEgressHost(raw, existing);
}

/** A wildcard egress entry (`*.host…`): it opens every subdomain, so Settings warns about it. */
export function isWildcardEgressEntry(entry: string): boolean {
  return entry.startsWith("*.");
}

/** An extra drain priority label (priorityLabels). Matching is exact and case-sensitive. */
export function checkPriorityLabel(
  raw: string,
  existing: readonly string[],
): ListEntryCheck<"empty" | "duplicate"> {
  const label = raw.trim();
  if (!label) return { ok: false, reason: "empty" };
  if (existing.includes(label)) return { ok: false, reason: "duplicate" };
  return { ok: true, value: label };
}

/** Review bots trusted by default (#4126): src/review-feedback-core.ts → REVIEW_FEEDBACK_PRESET_BOTS. */
export const REVIEW_FEEDBACK_PRESET_BOTS: readonly string[] = [
  "coderabbitai",
  "copilot-pull-request-reviewer",
  "copilot",
  "claude",
];
/** The server keeps at most this many review bots per repo. */
export const REVIEW_FEEDBACK_BOTS_MAX = 20;
const BOT_LOGIN_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

/** A review-bot login (reviewFeedbackBots): lowercased, without GitHub's `[bot]` suffix. */
export function checkReviewBot(
  raw: string,
  existing: readonly string[],
): ListEntryCheck<"empty" | "invalid" | "duplicate" | "full"> {
  const login = raw
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/, "");
  if (!login) return { ok: false, reason: "empty" };
  if (!BOT_LOGIN_RE.test(login)) return { ok: false, reason: "invalid" };
  if (existing.includes(login)) return { ok: false, reason: "duplicate" };
  if (existing.length >= REVIEW_FEEDBACK_BOTS_MAX) return { ok: false, reason: "full" };
  return { ok: true, value: login };
}
