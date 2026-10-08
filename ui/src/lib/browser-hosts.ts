// Client mirror of the server's browserAllowedHosts gate (src/validate.ts → validateBrowserAllowedHosts):
// the egress HOSTNAME_RE (src/egress.ts) plus the IP-literal refusal. Keep the two in sync.
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const IPV4_RE = /^\d+(\.\d+)+$/;

export type BrowserHostCheck =
  { ok: true; host: string } | { ok: false; reason: "empty" | "invalid" | "ip" | "duplicate" };

/** Validate + normalize one allowlist entry against the hosts already listed. */
export function checkBrowserHost(raw: string, existing: readonly string[]): BrowserHostCheck {
  const host = raw.trim().toLowerCase();
  if (!host) return { ok: false, reason: "empty" };
  if (IPV4_RE.test(host)) return { ok: false, reason: "ip" };
  if (!HOSTNAME_RE.test(host)) return { ok: false, reason: "invalid" };
  if (existing.includes(host)) return { ok: false, reason: "duplicate" };
  return { ok: true, host };
}
