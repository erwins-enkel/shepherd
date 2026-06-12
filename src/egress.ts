/**
 * Pure, host-agnostic egress-firewall config generators for the per-agent network sandbox.
 *
 * Self-contained + dependency-injectable: imports NO store/service/server (no cycles).
 * Every host touch (realpath, existence probe) is an injectable dep so tests never
 * require a real filesystem.
 *
 * The mechanism: an autonomous agent runs inside a rootless network namespace.
 * dnsmasq resolves ONLY allowlisted domains (pinning resolved IPs into an nftables
 * set); nft rejects all other outbound traffic. This module produces the config
 * artefacts consumed by later tasks (backend detection, the runner script, service
 * wiring). It never spawns processes itself.
 */

import { lstatSync } from "node:fs";
import { type PathProbeDeps, safeRealpath } from "./sandbox";
import type { ForgeMap } from "./forge/types";

// ── backend type ──────────────────────────────────────────────────────────────

/**
 * Network-namespace backend. "slirp4netns" = rootless netns via slirp4netns;
 * null = not available / disabled.
 */
export type EgressBackend = "slirp4netns" | null;

// ── Anthropic base set ────────────────────────────────────────────────────────

/**
 * Hosts that a compliant `claude` turn needs to reach Anthropic's API and
 * telemetry. Seeded empirically; the full set is finalized in a later task
 * (issue #551 Step 6) by reading the egress-drop log.
 */
export const ANTHROPIC_EGRESS_HOSTS: readonly string[] = [
  "api.anthropic.com",
  "statsig.anthropic.com",
] as const;

// ── GitHub well-known set ─────────────────────────────────────────────────────

export const GITHUB_EGRESS_HOSTS: readonly string[] = [
  "api.github.com",
  "codeload.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "uploads.github.com",
] as const;

// ── named constants ───────────────────────────────────────────────────────────

/** Default nft set identifier used in dnsmasq --nftset and nft ruleset. */
const DEFAULT_NFT_SET = "inet#egress#allowed";

/** slirp4netns built-in DNS forwarder — always reachable at this IP inside the netns. */
const SLIRP_RESOLVER = "10.0.2.3";

/** dnsmasq min-cache-ttl in seconds: keeps resolved IPs pinned in the nft set longer. */
const DEFAULT_MIN_CACHE_TTL = 600;

// ── hostname validation ───────────────────────────────────────────────────────

/**
 * RFC 1123 hostname: each label starts+ends with alphanumeric, hyphens in the middle;
 * requires ≥2 labels (dot-separated), so bare names and leading/trailing-hyphen labels
 * (e.g. -foo.com, foo-.com, .foo.com) are rejected.
 */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function normalizeHost(raw: string): string | null {
  const h = raw.trim().toLowerCase();
  if (!h) return null;
  if (!HOSTNAME_RE.test(h)) return null;
  return h;
}

// ── allowlist builder ─────────────────────────────────────────────────────────

/**
 * Build the deduped, sorted egress allowlist of domains for an agent spawn.
 *
 *   - Anthropic base set: always included.
 *   - Forge hosts: every map KEY (the host); for `type === "github"` entries the
 *     GitHub well-known set is also added; for a `baseUrl`, its hostname is extracted.
 *     When `forges` is EMPTY (no entries), the GitHub well-known set is added as the
 *     default forge (Shepherd defaults to github.com via the `gh` CLI).
 *   - `extraHosts`: operator additions, appended verbatim (after normalization).
 *
 * Invalid hosts (empty, non-hostname characters, no dot) are silently dropped.
 */
export function buildEgressAllowlist(opts: { forges: ForgeMap; extraHosts?: string[] }): string[] {
  const { forges, extraHosts = [] } = opts;
  const raw: string[] = [];

  // 1. Anthropic base — always.
  raw.push(...ANTHROPIC_EGRESS_HOSTS);

  // 2. Forge hosts.
  const entries = Object.entries(forges);
  if (entries.length === 0) {
    // Default forge: Shepherd uses github.com via the `gh` CLI.
    raw.push(...GITHUB_EGRESS_HOSTS);
  } else {
    for (const [host, cfg] of entries) {
      // The map key is a host (e.g. "github.com", "git.example.com").
      raw.push(host);

      // GitHub type → add the well-known API/CDN set.
      if (cfg.type === "github") {
        raw.push(...GITHUB_EGRESS_HOSTS);
      }

      // baseUrl → extract its hostname.
      if (cfg.baseUrl) {
        try {
          raw.push(new URL(cfg.baseUrl).hostname);
        } catch {
          // Malformed URL — skip silently.
        }
      }
    }
  }

  // 3. Operator-supplied extras.
  raw.push(...extraHosts);

  // 4. Normalize, deduplicate, sort.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of raw) {
    const norm = normalizeHost(h);
    if (norm === null || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  out.sort();
  return out;
}

// ── exact / suffix host matching ──────────────────────────────────────────────

/**
 * True when `host` matches an entry in `allowlist` exactly OR as a subdomain.
 * E.g. allowlist entry `"anthropic.com"` matches `"api.anthropic.com"`.
 *
 * Used by the drop-watcher. dnsmasq's `--server=/domain/` already does suffix
 * matching natively; this function exists for reuse in the drop-log parser.
 */
export function hostMatchesAllowlist(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase();
  for (const entry of allowlist) {
    const e = entry.toLowerCase();
    if (h === e) return true;
    if (h.endsWith("." + e)) return true;
  }
  return false;
}

// ── config types + builder ────────────────────────────────────────────────────

/** All generated config artefacts for one egress-sandboxed agent run. */
export interface EgressConfig {
  /** dnsmasq argv (without the executable name). */
  dnsmasqArgv: string[];
  /** The nft ruleset text — pass to `nft -f -`. */
  nftRuleset: string;
  /** Content for the resolv.conf override file. */
  resolvConf: string;
  /** Content for the nsswitch.conf override file. */
  nsswitchConf: string;
}

/**
 * Generate ALL egress config artefacts from the allowlist. PURE — no I/O.
 *
 * @param allowlist  Deduped, sorted hostname list (from buildEgressAllowlist).
 * @param opts.tmpDir        Per-agent tmp directory for dnsmasq log + override files.
 * @param opts.resolver      Upstream DNS resolver IP (default "10.0.2.3" = slirp4netns's built-in).
 * @param opts.minCacheTtl   dnsmasq min-cache-ttl seconds (default 600).
 * @param opts.nftSet        nft set identifier (default "inet#egress#allowed").
 */
export function buildEgressConfig(
  allowlist: string[],
  opts: {
    tmpDir: string;
    resolver?: string;
    minCacheTtl?: number;
    nftSet?: string;
  },
): EgressConfig {
  const resolver = opts.resolver ?? SLIRP_RESOLVER;
  const minCacheTtl = opts.minCacheTtl ?? DEFAULT_MIN_CACHE_TTL;
  const nftSet = opts.nftSet ?? DEFAULT_NFT_SET;
  const { tmpDir } = opts;

  // Guard: nftSet is interpolated directly into dnsmasq and nft config — must be safe.
  if (!/^[a-z0-9#_]+$/i.test(nftSet)) {
    throw new Error(`buildEgressConfig: invalid nftSet "${nftSet}" — must match /^[a-z0-9#_]+$/i`);
  }

  // ── dnsmasq argv ────────────────────────────────────────────────────────────
  // Resolves only allowlisted domains, pins resolved IPs into the nft set,
  // filters AAAA, logs queries.
  const dnsmasqArgv: string[] = [
    "-d",
    "--no-resolv",
    "--no-hosts",
    "--filter-AAAA",
    "-p",
    "53",
    "-i",
    "lo",
    "--bind-interfaces",
  ];

  // One --server and one --nftset per domain.
  for (const domain of allowlist) {
    dnsmasqArgv.push(`--server=/${domain}/${resolver}`);
    dnsmasqArgv.push(`--nftset=/${domain}/${nftSet}`);
  }

  dnsmasqArgv.push(`--min-cache-ttl=${minCacheTtl}`);
  dnsmasqArgv.push("--log-queries");
  dnsmasqArgv.push(`--log-facility=${tmpDir}/dns.log`);

  // ── nft ruleset ─────────────────────────────────────────────────────────────
  // family inet, table egress, default-drop with explicit REJECT for fast-fail.
  const nftRuleset = `table inet egress {
  set allowed {
    type ipv4_addr
    flags timeout
  }
  chain out {
    type filter hook output priority 0; policy drop;
    oifname "lo" accept
    ct state established,related accept
    ip daddr ${resolver} udp dport 53 accept
    ip daddr ${resolver} tcp dport 53 accept
    ip daddr @allowed accept
    meta nfproto ipv6 reject
    meta l4proto tcp reject with tcp reset
    reject
  }
}
`;

  return {
    dnsmasqArgv,
    nftRuleset,
    resolvConf: "nameserver 127.0.0.1\n",
    nsswitchConf: "hosts: files dns\n",
  };
}

// ── bwrap override flags ───────────────────────────────────────────────────────

/** Deps for egressMembraneOverrideFlags (extends PathProbeDeps). */
export interface EgressOverrideDeps extends PathProbeDeps {
  /**
   * realpath implementation (default: safeRealpath from sandbox.ts).
   * Receives the path to resolve; returns the realpath or the input on error.
   */
  realpath?: (p: string) => string;
  /**
   * Returns true when the path is a symlink (default: lstatSync().isSymbolicLink()).
   * Injectable so tests can simulate symlinked vs plain /etc/resolv.conf.
   */
  isSymlink?: (p: string) => boolean;
}

const RESOLV_CONF = "/etc/resolv.conf";
const NSSWITCH_CONF = "/etc/nsswitch.conf";

/**
 * Returns ADDITIVE bwrap bind flags to append AFTER the membrane flags.
 *
 * - `--ro-bind <tmpDir>/nsswitch.conf /etc/nsswitch.conf`
 * - `--ro-bind <tmpDir>/resolv.conf <realpath-of-/etc/resolv.conf>`
 *   (binding onto the symlink target avoids bwrap's inability to bind onto a
 *   symlink path whose target is absent inside the sandbox — spike-confirmed).
 *
 * @param tmpDir  Per-agent tmp dir holding the generated override files.
 * @param deps    Injectable host probes (realpath + isSymlink).
 */
export function egressMembraneOverrideFlags(
  tmpDir: string,
  deps: EgressOverrideDeps = {},
): string[] {
  const realpath = deps.realpath ?? safeRealpath;
  const isSymlink =
    deps.isSymlink ??
    ((p: string) => {
      try {
        return lstatSync(p).isSymbolicLink();
      } catch {
        return false;
      }
    });

  // Resolve the bind target for resolv.conf.
  // On systemd-resolved hosts /etc/resolv.conf is a symlink to a path that may not
  // exist under the bwrap-constructed root; bind directly onto the REALPATH instead.
  const resolvTarget = isSymlink(RESOLV_CONF) ? realpath(RESOLV_CONF) : RESOLV_CONF;

  return [
    "--ro-bind",
    `${tmpDir}/nsswitch.conf`,
    NSSWITCH_CONF,
    "--ro-bind",
    `${tmpDir}/resolv.conf`,
    resolvTarget,
  ];
}
