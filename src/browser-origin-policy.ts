/**
 * Browser origin allowlist (#2883): where an autonomous session's confined Browser Attach may
 * connect. Enforced by `BrowserEgressProxy` on every SOCKS CONNECT the session's isolated browser
 * context makes — navigations, redirects, subresources, WebSockets, workers and popups alike.
 *
 * Allowed:
 *  - an allowlisted hostname (exact match) on port 80/443 whose EVERY resolved address is public;
 *    the proxy connects to the vetted address, so a later DNS answer cannot rebind it;
 *  - the session's own Preview port on loopback (`localhost`/`127.0.0.1`/`[::1]`) (see
 *    `resolvePreviewPort`);
 *  - the session's verified in-netns dev port on loopback, tunnelled to the host port that
 *    slirp4netns forwards to it (#2889, `NetnsDevForwarder`) so the origin stays `localhost:<devPort>`.
 * Everything else is denied: other loopback ports (Shepherd, agent ingress), IP literals, and any
 * name resolving into loopback, private, CGNAT (Tailscale), link-local, ULA or other special ranges.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export interface OriginPolicy {
  /** Allowlisted hostnames (normalized), read live per connection. */
  allowedHosts(): readonly string[];
  /** The session's validated Preview port (`resolvePreviewPort`), read live; null → no loopback. */
  previewPort(): number | null;
  /** The session's verified in-netns dev port (#2889), or null. */
  devPort?(): Promise<number | null>;
  /** The host loopback port reaching the in-netns dev server when `port` is its dev port, else null. */
  devForward?(port: number): Promise<number | null>;
}

export type LookupFn = (host: string) => Promise<{ address: string; family: number }[]>;

export type DestinationVerdict =
  { allow: true; address: string; port: number } | { allow: false; reason: string };

const defaultLookup: LookupFn = (host) => dnsLookup(host, { all: true, verbatim: true });

const DENIED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  DENIED.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  DENIED.addSubnet(net, prefix, "ipv6");

/** `::ffff:a.b.c.d` → `a.b.c.d`; other addresses unchanged. */
function unmapV4(address: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return m ? m[1]! : address;
}

/** True for any address a confined browser must never reach (loopback, private, special). */
export function isDeniedAddress(address: string): boolean {
  const a = unmapV4(address);
  const family = isIP(a);
  if (family === 0) return true;
  return DENIED.check(a, family === 4 ? "ipv4" : "ipv6");
}

/** Lowercase, strip `[]` and a trailing dot — the SOCKS host as Chromium sent it. */
function normalizeDestHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** The verdict for one CONNECT to `host:port`. Async only for DNS and the dev forward; never throws. */
export async function checkDestination(
  policy: OriginPolicy,
  rawHost: string,
  port: number,
  lookup: LookupFn = defaultLookup,
): Promise<DestinationVerdict> {
  const host = normalizeDestHost(rawHost);
  if (LOOPBACK_NAMES.has(host)) {
    if (port === policy.previewPort()) return { allow: true, address: "127.0.0.1", port };
    const hostPort = (await policy.devForward?.(port).catch(() => null)) ?? null;
    return hostPort !== null
      ? { allow: true, address: "127.0.0.1", port: hostPort }
      : { allow: false, reason: "loopback port not allowed" };
  }
  if (isIP(host) !== 0) return { allow: false, reason: "IP literals are not allowed" };
  if (!policy.allowedHosts().includes(host))
    return { allow: false, reason: "host not allowlisted" };
  if (port !== 80 && port !== 443) return { allow: false, reason: "only ports 80 and 443" };
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host);
  } catch {
    return { allow: false, reason: "DNS lookup failed" };
  }
  if (addresses.length === 0) return { allow: false, reason: "DNS lookup failed" };
  if (addresses.some((a) => isDeniedAddress(a.address)))
    return { allow: false, reason: "host resolves to a non-public address" };
  return { allow: true, address: unmapV4(addresses[0]!.address), port };
}

/**
 * The session's Preview port as a loopback exception, or null. The Preview listener is
 * Shepherd's own `127.0.0.1` proxy to the session's host dev server; it is accepted only inside
 * the configured preview range, never as one of Shepherd's own ports, and only while the dev port
 * it relays to is not one of them either.
 */
export function resolvePreviewPort(opts: {
  previewPort: number | null | undefined;
  devPort: number | null | undefined;
  rangeBase: number;
  rangeCount: number;
  denyPorts: readonly (number | null | undefined)[];
}): number | null {
  const { previewPort, devPort, rangeBase, rangeCount, denyPorts } = opts;
  if (typeof previewPort !== "number" || !Number.isInteger(previewPort)) return null;
  if (previewPort < rangeBase || previewPort >= rangeBase + rangeCount) return null;
  if (denyPorts.includes(previewPort)) return null;
  if (devPort != null && denyPorts.includes(devPort)) return null;
  return previewPort;
}

/** True when a cookie for `domain` belongs to an allowed host (or to `localhost` when allowed). */
export function cookieMatchesHosts(
  domain: string,
  hosts: readonly string[],
  includeLocalhost: boolean,
): boolean {
  const d = domain.replace(/^\./, "").toLowerCase();
  if (!d) return false;
  if (d === "localhost") return includeLocalhost;
  return hosts.some((h) => h === d || h.endsWith(`.${d}`));
}
