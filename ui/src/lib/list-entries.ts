// Client mirrors of the server's gates for the repo-config list fields. Keep each in sync with
// its server rule; test/list-entries-parity.test.ts runs both over the same inputs.
//  - hosts: the egress HOSTNAME_RE (src/egress.ts → normalizeHost, used by src/validate.ts →
//    validateHostList), plus the IP-literal refusal of validateBrowserAllowedHosts.
//  - priority labels: src/server.ts → parsePriorityLabels (trimmed, non-empty).
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const IPV4_RE = /^\d+(\.\d+)+$/;

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

/** An extra egress-allowlist host (egressExtraHosts). The server accepts a dotted-quad here. */
export function checkEgressHost(
  raw: string,
  existing: readonly string[],
): ListEntryCheck<"empty" | "invalid" | "duplicate"> {
  const host = raw.trim().toLowerCase();
  if (!host) return { ok: false, reason: "empty" };
  if (!HOSTNAME_RE.test(host)) return { ok: false, reason: "invalid" };
  if (existing.includes(host)) return { ok: false, reason: "duplicate" };
  return { ok: true, value: host };
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
