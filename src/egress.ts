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

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "./instrument";
import { resolveNodeBin } from "./node-bin";
import { shepherdRuntimeDir } from "./runtime-dir";
import {
  type BackendProbeDeps,
  type MembraneInputs,
  type PathProbeDeps,
  buildMembraneFlags,
  defaultRun,
  safeRealpath,
} from "./sandbox";
import type { ForgeMap } from "./forge/types";

// ── backend type ──────────────────────────────────────────────────────────────

/**
 * Network-namespace backend. "slirp4netns" = rootless netns via slirp4netns;
 * null = not available / disabled.
 */
export type EgressBackend = "slirp4netns" | null;

// ── backend detection ─────────────────────────────────────────────────────────

/**
 * Injectable deps for detectEgressBackend. Extends BackendProbeDeps (home,
 * claudeDir, nodeBinReal, run, exists) so the probe membrane and egress overrides
 * can share the same injected host fields.
 *
 * Also carries the EgressOverrideDeps fields (realpath, isSymlink) so the same
 * deps object can be forwarded to egressMembraneOverrideFlags without a cast.
 * The EgressOverrideDeps interface is defined later in this file; inlining the two
 * optional fields here avoids a circular reference with that later type.
 */
export interface EgressBackendProbeDeps extends BackendProbeDeps {
  /** realpath for /etc/resolv.conf symlink resolution (forwarded to egressMembraneOverrideFlags). */
  realpath?: (p: string) => string;
  /** isSymlink probe for /etc/resolv.conf (forwarded to egressMembraneOverrideFlags). */
  isSymlink?: (p: string) => boolean;
  /**
   * Override for writing config files in the temp dir; default writeFileSync.
   * Injectable so tests can skip real I/O.
   */
  writeFile?: (path: string, data: string) => void;
  /**
   * Override for mkdtempSync; default mkdtempSync from node:fs.
   * Injectable so tests can provide a deterministic path.
   */
  mkdtemp?: (prefix: string) => string;
  /**
   * Override for rmSync (cleanup); default rmSync from node:fs.
   */
  rmdir?: (path: string) => void;
  /**
   * Override for the egress-runner.sh absolute path resolution.
   * When provided, used directly instead of resolving relative to import.meta.dir.
   */
  runnerPath?: string;
}

/** Required tools for the egress firewall stack. */
const EGRESS_REQUIRED_TOOLS = ["setpriv", "unshare", "slirp4netns", "nft", "dnsmasq"] as const;

/**
 * Absolute path to `scripts/egress-runner.sh`, resolved relative to this file
 * (src/) up to the repo root. The single source of truth both `detectEgressBackend`
 * (self-test) and `wrapEgress` (production spawn) resolve through.
 */
export function egressRunnerPath(): string {
  // import.meta.dir is the directory of this file (src/); go up one level to repo root.
  return join(resolve(import.meta.dir, ".."), "scripts", "egress-runner.sh");
}

let _egressBackendCache: EgressBackend | undefined;

/** Clear the per-process egress backend cache (tests). */
export function resetEgressBackendCache(): void {
  _egressBackendCache = undefined;
}

/** Returns false if any required tool fails --version; caches null and returns false. */
function checkRequiredTools(run: (cmd: string, args: string[]) => { status: number }): boolean {
  for (const tool of EGRESS_REQUIRED_TOOLS) {
    if (run(tool, ["--version"]).status !== 0) return false;
  }
  return true;
}

/** Build the probe MembraneInputs from deps + probeDir. */
function buildProbeMembrane(probeDir: string, deps: EgressBackendProbeDeps): MembraneInputs {
  const home = deps.home ?? process.env.HOME ?? "/root";
  const claudeDir = deps.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? `${home}/.claude`;
  const nodeBinReal = deps.nodeBinReal ?? safeRealpath(resolveNodeBin());
  return {
    worktreePath: probeDir,
    gitCommonDir: probeDir,
    isolated: false,
    repoPath: probeDir,
    claudeDir,
    home,
    nodeBinReal,
  };
}

/** Representative port for the self-test only — the probe verifies the host-gateway rule LOADS,
 *  not that it routes anywhere. The real spawn passes the live ingress port. */
const PROBE_GATEWAY_PORT = 7330;

/** Write probe config files to tmpDir and return the inner bwrap argv. */
function buildProbeInnerArgv(tmpDir: string, deps: EgressBackendProbeDeps): string[] {
  const writeFile = deps.writeFile ?? ((p: string, d: string) => writeFileSync(p, d, "utf8"));
  // When host-loopback is available, load the SAME rule shape the real spawn uses, so the
  // self-test actually nft-loads it; omit it otherwise (probe matches production omission).
  const hostGateway = detectEgressHostLoopback()
    ? { ip: SLIRP_HOST_GATEWAY, port: PROBE_GATEWAY_PORT }
    : undefined;
  const cfg = buildEgressConfig([...ANTHROPIC_EGRESS_HOSTS], { tmpDir, hostGateway });
  writeFile(join(tmpDir, "egress.nft"), cfg.nftRuleset);
  writeFile(join(tmpDir, "dnsmasq.argv"), cfg.dnsmasqArgv.join("\n"));
  writeFile(join(tmpDir, "resolv.conf"), cfg.resolvConf);
  writeFile(join(tmpDir, "nsswitch.conf"), cfg.nsswitchConf);

  const probeMembrane = buildProbeMembrane(tmpDir, deps);
  const membraneFlags = buildMembraneFlags(probeMembrane, deps);
  const overrideFlags = egressMembraneOverrideFlags(tmpDir, deps);
  // Inner argv: bwrap <membrane flags> <egress override flags> -- /bin/sh -c "exit 0"
  // This exercises userns-in-userns + egress override binds; exit 0 proves the stack.
  return ["bwrap", ...membraneFlags, ...overrideFlags, "--", "/bin/sh", "-c", "exit 0"];
}

/**
 * Detect the egress-firewall backend with a real per-host SELF-TEST (cached per process).
 *
 * Not merely checking for tool presence: the probe builds the FULL production nesting
 * (membrane bwrap inside egress-runner.sh's netns) and runs it. Only an exit-0 proves
 * the entire stack — userns-in-userns, nft load, dnsmasq start — actually works.
 *
 * Available ("slirp4netns") iff ALL required tools exist AND the full-nesting probe exits 0.
 * Returns null on any failure, including throws (never crashes the caller).
 */
export function detectEgressBackend(deps: EgressBackendProbeDeps = {}): EgressBackend {
  if (_egressBackendCache !== undefined) return _egressBackendCache;

  const run = deps.run ?? defaultRun;
  const exists = deps.exists ?? existsSync;
  const cleanupFn =
    deps.rmdir ??
    ((p: string) => {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    });

  let tmpDir: string | undefined;
  try {
    // 1. Cheap presence gate: all required tools must be runnable.
    if (!checkRequiredTools(run)) {
      _egressBackendCache = null;
      return _egressBackendCache;
    }

    // 2. Resolve the egress-runner.sh absolute path.
    const runnerPath = deps.runnerPath ?? egressRunnerPath();
    if (!exists(runnerPath)) {
      _egressBackendCache = null;
      return _egressBackendCache;
    }

    // 3. Full-nesting self-test.
    const mkdtemp = deps.mkdtemp ?? ((prefix: string) => mkdtempSync(prefix));
    tmpDir = mkdtemp(join(tmpdir(), "shepherd-egress-probe-"));

    const inner = buildProbeInnerArgv(tmpDir, deps);
    const probe = run(runnerPath, ["--tmp", tmpDir, "--", ...inner]);
    _egressBackendCache = probe.status === 0 ? "slirp4netns" : null;
    return _egressBackendCache;
  } catch {
    _egressBackendCache = null;
    return _egressBackendCache;
  } finally {
    if (tmpDir !== undefined) cleanupFn(tmpDir);
  }
}

// ── host-loopback capability probe ──────────────────────────────────────────────

let _egressHostLoopbackCache: boolean | undefined;

/** Clear the per-process host-loopback capability cache (tests). */
export function resetEgressHostLoopbackCache(): void {
  _egressHostLoopbackCache = undefined;
}

/** Parse the first X.Y.Z (or X.Y) triple from slirp4netns --version output. */
function parseSemverish(out: string): [number, number, number] | null {
  const m = out.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

/** Numeric major.minor.patch comparison: a >= b. */
function semverGte(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return true;
}

/**
 * Detect whether the host's slirp4netns is recent enough to route the host-loopback
 * gateway (10.0.2.2 → host 127.0.0.1), gating agent→Shepherd reachability. Cached per
 * process. Best-effort: NEVER throws — a capture failure or unparseable version is false.
 *
 * @param deps.versionOutput  Override for capturing `slirp4netns --version` stdout
 *                            (default: execFileSync wrapper), trimmed or null on throw.
 */
export function detectEgressHostLoopback(
  deps: { versionOutput?: () => string | null } = {},
): boolean {
  if (_egressHostLoopbackCache !== undefined) return _egressHostLoopbackCache;

  const versionOutput =
    deps.versionOutput ??
    (() => {
      try {
        return execFileSync("slirp4netns", ["--version"], { encoding: "utf8" }).toString().trim();
      } catch {
        return null;
      }
    });

  let result = false;
  try {
    const out = versionOutput();
    const parsed = out ? parseSemverish(out) : null;
    if (parsed) result = semverGte(parsed, SLIRP4NETNS_HOSTLOOPBACK_MIN);
  } catch {
    result = false; // best-effort — never throw
  }

  _egressHostLoopbackCache = result;
  return result;
}

// ── Anthropic base set ────────────────────────────────────────────────────────

/**
 * Hosts that a compliant `claude` turn needs to reach Anthropic's API and
 * telemetry. FINALIZED EMPIRICALLY (issue #551 Step 6): a real autonomous
 * `claude -p` turn run under this firewall completed successfully reaching ONLY
 * `api.anthropic.com`. Hosts claude additionally *probed* but does not need —
 * `mcp-proxy.anthropic.com`, `mcp.vercel.com` (MCP connectors), `registry.npmjs.org`,
 * `http-intake.logs.*.datadoghq.com` (Datadog telemetry) — are intentionally NOT
 * allowlisted: optional, an exfil surface, and the turn degraded gracefully without
 * them. `statsig.anthropic.com` (feature-gate telemetry) is kept as harmless
 * best-effort. Operators who need a registry/MCP host in autonomous mode add it via
 * SHEPHERD_SANDBOX_EXTRA_HOSTS / the per-repo egressExtraHosts setting.
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

/** slirp4netns host-loopback gateway: inside the netns this IP routes to the host's 127.0.0.1
 *  (reachable once `--disable-host-loopback` is dropped from the slirp invocation). */
export const SLIRP_HOST_GATEWAY = "10.0.2.2";

/** Minimum slirp4netns version whose host-loopback (10.0.2.2 → host 127.0.0.1) we rely on.
 *  Human-readable source-of-truth: "1.0.0" — a broadly-available modern floor; below it we fall back
 *  to polling (see detectEgressHostLoopback). Module-private (only detectEgressHostLoopback uses it). */
const SLIRP4NETNS_HOSTLOOPBACK_MIN: [number, number, number] = [1, 0, 0];

/** dnsmasq min-cache-ttl in seconds: keeps resolved IPs pinned in the nft set longer. */
const DEFAULT_MIN_CACHE_TTL = 600;

// ── hostname validation ───────────────────────────────────────────────────────

/**
 * RFC 1123 hostname: each label starts+ends with alphanumeric, hyphens in the middle;
 * requires ≥2 labels (dot-separated), so bare names and leading/trailing-hyphen labels
 * (e.g. -foo.com, foo-.com, .foo.com) are rejected.
 */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Trim + lowercase a host and accept it ONLY if it is a syntactically valid
 * hostname (RFC-1123-ish: ≥2 dot-separated labels, no leading/trailing hyphen,
 * no empty labels). Returns the normalized host, or null to reject.
 *
 * This is the SINGLE gate for what may enter the egress allowlist. `validate.ts`
 * reuses it so a host that passes repo-config validation is exactly a host that
 * will make the allowlist — no "persisted but silently dropped at spawn" skew.
 */
export function normalizeHost(raw: string): string | null {
  const h = raw.trim().toLowerCase();
  if (!h) return null;
  if (!HOSTNAME_RE.test(h)) return null;
  return h;
}

// ── allowlist builder ─────────────────────────────────────────────────────────

/** Collect all raw hosts for one forge entry (map key + github set + baseUrl hostname). */
function collectForgeEntryHosts(host: string, cfg: ForgeMap[string]): string[] {
  const hosts: string[] = [host];
  // Resolve the forge kind the SAME way the canonical resolver does (kindFor,
  // src/forge/index.ts): an explicit `type` wins, otherwise `github.com` is github.
  // So a `{"github.com":{token}}` entry (type omitted) still gets the GitHub REST /
  // clone / upload hosts — without them `gh pr create` and clones fail under the firewall.
  const isGithub = cfg.type ? cfg.type === "github" : host === "github.com";
  if (isGithub) hosts.push(...GITHUB_EGRESS_HOSTS);
  if (cfg.baseUrl) {
    try {
      hosts.push(new URL(cfg.baseUrl).hostname);
    } catch {
      // Malformed URL — skip silently.
    }
  }
  return hosts;
}

/** Normalize, deduplicate, and sort a raw host list. */
function normalizeDedupeSort(raw: string[]): string[] {
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
  const raw: string[] = [...ANTHROPIC_EGRESS_HOSTS];

  const entries = Object.entries(forges);
  if (entries.length === 0) {
    // Default forge: Shepherd uses github.com via the `gh` CLI.
    raw.push(...GITHUB_EGRESS_HOSTS);
  } else {
    for (const [host, cfg] of entries) {
      raw.push(...collectForgeEntryHosts(host, cfg));
    }
  }

  raw.push(...extraHosts);
  return normalizeDedupeSort(raw);
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
 * @param opts.hostGateway   When set, opens exactly that host IP+port outbound (least-privilege
 *                           agent→Shepherd reachability via the slirp host-loopback gateway).
 */
export function buildEgressConfig(
  allowlist: string[],
  opts: {
    tmpDir: string;
    resolver?: string;
    minCacheTtl?: number;
    nftSet?: string;
    hostGateway?: { ip: string; port: number };
  },
): EgressConfig {
  const resolver = opts.resolver ?? SLIRP_RESOLVER;
  const minCacheTtl = opts.minCacheTtl ?? DEFAULT_MIN_CACHE_TTL;
  const nftSet = opts.nftSet ?? DEFAULT_NFT_SET;
  const { tmpDir, hostGateway } = opts;

  // Guard: nftSet is interpolated directly into dnsmasq and nft config — must be safe.
  if (!/^[a-z0-9#_]+$/i.test(nftSet)) {
    throw new Error(`buildEgressConfig: invalid nftSet "${nftSet}" — must match /^[a-z0-9#_]+$/i`);
  }

  // Guard: hostGateway.port is interpolated directly into the nft ruleset — must be a port.
  if (
    hostGateway &&
    !(Number.isInteger(hostGateway.port) && hostGateway.port >= 1 && hostGateway.port <= 65535)
  ) {
    throw new Error(
      `buildEgressConfig: invalid hostGateway.port "${hostGateway.port}" — must be an integer 1..65535`,
    );
  }

  // ── dnsmasq argv ────────────────────────────────────────────────────────────
  // Resolves only allowlisted domains, pins resolved IPs into the nft set,
  // filters AAAA, logs queries.
  //
  // -d (--no-daemon), NOT -k (--keep-in-foreground): both stay foreground for the
  // runner's liveness supervision, but ONLY -d also skips dnsmasq's privilege drop
  // (setgid/setgroups to "nobody") and pidfile write. Inside the rootless user+net
  // namespace the supplementary group "nobody" (65534) is UNMAPPED, so -k's
  // setgroups() call fails EPERM and dnsmasq refuses to start — which would make
  // the (now fail-closed) runner abort EVERY spawn. -d is the only foreground mode
  // that starts here. Its one downside — logging to stderr — is neutralised by the
  // runner redirecting dnsmasq's stdio to /dev/null, so nothing leaks onto the
  // agent's inherited PTY; the queries still land in --log-facility.
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
  // When hostGateway is set, ONE least-privilege allow for the host IP+port goes
  // right after the @allowed accept (return traffic is covered by ct established).
  const hostGatewayRule = hostGateway
    ? `\n    ip daddr ${hostGateway.ip} tcp dport ${hostGateway.port} accept`
    : "";
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
    ip daddr @allowed accept${hostGatewayRule}
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

// ── spawn orchestration prep (impure — kept out of the pure config core) ────────

/**
 * Deterministic per-session temp dir holding the generated egress config files +
 * the dns.log the drop-watcher tails. Lives under the user-private runtime dir
 * ({@link shepherdRuntimeDir}, `0700`) as `egress/<sessionId>` — one dir per session
 * id so the startup sweep can reconcile orphans against the live set.
 */
export function egressTmpDir(sessionId: string): string {
  return shepherdRuntimeDir("egress", sessionId);
}

/** Root dir holding every per-session egress temp dir (for the orphan sweep). */
function egressTmpRoot(): string {
  return shepherdRuntimeDir("egress");
}

/**
 * Materialize the egress config artefacts into `tmpDir` (created recursively).
 * Writes egress.nft, dnsmasq.argv (one arg per line), resolv.conf, nsswitch.conf —
 * exactly the files egress-runner.sh + the membrane override binds consume.
 */
export function writeEgressConfigFiles(tmpDir: string, cfg: EgressConfig): void {
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, "egress.nft"), cfg.nftRuleset, "utf8");
  writeFileSync(join(tmpDir, "dnsmasq.argv"), cfg.dnsmasqArgv.join("\n"), "utf8");
  writeFileSync(join(tmpDir, "resolv.conf"), cfg.resolvConf, "utf8");
  writeFileSync(join(tmpDir, "nsswitch.conf"), cfg.nsswitchConf, "utf8");
}

/**
 * Wrap an already-built bwrap argv in the egress-runner invocation:
 *   `<runner> --tmp <tmpDir> -- <bwrapArgv...>`
 * The runner loads <tmpDir>/egress.nft + <tmpDir>/dnsmasq.argv and execs the bwrap
 * argv inside the firewalled netns. `runnerPath` is injectable for tests.
 */
export function wrapEgress(
  bwrapArgv: string[],
  tmpDir: string,
  runnerPath = egressRunnerPath(),
): string[] {
  return [runnerPath, "--tmp", tmpDir, "--", ...bwrapArgv];
}

/**
 * Best-effort removal of one session's egress temp dir (config + dns.log). Called
 * at session teardown/archive. Never throws — a missing dir or a races-with-runner
 * removal is a no-op.
 */
export function removeEgressTmp(sessionId: string): void {
  try {
    rmSync(egressTmpDir(sessionId), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/**
 * Startup reconcile sweep: remove any `egress/<id>` dir whose id is NOT in
 * `liveSessionIds` (the non-archived session set). Bounds unbounded growth from
 * sessions whose teardown removal was missed (crash, restart). Best-effort —
 * never throws; a single unremovable entry is skipped.
 */
export function sweepEgressTmp(liveSessionIds: Iterable<string>): void {
  const live = new Set(liveSessionIds);
  let entries: string[];
  try {
    entries = readdirSync(egressTmpRoot());
  } catch {
    return; // root absent → nothing to sweep
  }
  for (const id of entries) {
    if (live.has(id)) continue;
    try {
      rmSync(join(egressTmpRoot(), id), { recursive: true, force: true });
    } catch {
      // best-effort — skip this entry
    }
  }
}
