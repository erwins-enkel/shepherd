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
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  constants as fsConstants,
} from "node:fs";
import * as fsp from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
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

/** Clear the per-process egress backend cache. {@link refreshEgressBackend} overwrites it in
 *  production (the DIAGNOSE re-probe); this plain reset is for tests. */
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

/** Probe payload: succeeds only when the sandboxed agent is not uid 0. */
const PROBE_UID_CHECK = 'test "$(id -u)" != 0';

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
  // Inner argv: bwrap <membrane flags> <egress override flags> -- /bin/sh -c <uid check>
  // This exercises userns-in-userns + egress override binds; exit 0 proves the stack AND that the
  // agent would not run as root (claude refuses to launch as root).
  return ["bwrap", ...membraneFlags, ...overrideFlags, "--", "/bin/sh", "-c", PROBE_UID_CHECK];
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

// ── async re-probe (DIAGNOSE `sandbox_egress`, #3459) ────────────────────────

const execFileAsync = promisify(execFile);

/** Budget for each async probe step. The self-test brings up a netns, slirp4netns, dnsmasq, an nft
 *  ruleset and a nested bwrap, so it gets far more than the 5s generic diagnostics budget. */
const EGRESS_PROBE_TIMEOUT_MS = 15_000;

/** Longest self-test output tail written to the server log. */
const EGRESS_PROBE_DETAIL_MAX = 2_000;

/** What the DIAGNOSE row classifies: the verdict plus which required tools are absent (empty when
 *  all are present — a null `backend` then means the self-test itself failed). */
export interface EgressProbeFacts {
  backend: EgressBackend;
  missingTools: string[];
}

/** Captured run for the async probe. */
export interface EgressCapturedRun {
  status: number;
  output: string;
}

export interface EgressRefreshDeps extends EgressBackendProbeDeps {
  /** Async spawn + capture; default `execFileAsync` with {@link EGRESS_PROBE_TIMEOUT_MS}. A non-zero
   *  exit RESOLVES with its status; a spawn that could not run to completion (timeout) REJECTS. */
  runCapture?: (cmd: string, args: string[]) => Promise<EgressCapturedRun>;
}

/** Default capture: async (never `execFileSync` — the server is one Bun loop). Refuses to run under
 *  NODE_ENV=test so an un-injected test can never spawn the real firewall stack. */
async function defaultEgressRunCapture(cmd: string, args: string[]): Promise<EgressCapturedRun> {
  if (process.env.NODE_ENV === "test") {
    throw new Error(
      "refreshEgressBackend reached its real spawn under NODE_ENV=test — inject runCapture",
    );
  }
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      encoding: "utf8",
      timeout: EGRESS_PROBE_TIMEOUT_MS,
    });
    return { status: 0, output: `${stdout}${stderr}` };
  } catch (e) {
    const err = e as { code?: unknown; killed?: boolean; stdout?: string; stderr?: string };
    // ENOENT (tool absent) has a string code: that IS a definitive "missing", not a failure to probe.
    if (err.code === "ENOENT") return { status: 127, output: "" };
    // A timeout kills the child (`killed`, no numeric code): the probe failed to run → reject.
    if (err.killed || typeof err.code !== "number") throw e;
    return { status: err.code, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/** Run the full-nesting self-test (tools already known present). Writes no cache. */
async function runEgressSelfTest(
  deps: EgressRefreshDeps,
  runCapture: (cmd: string, args: string[]) => Promise<EgressCapturedRun>,
): Promise<EgressBackend> {
  const runnerPath = deps.runnerPath ?? egressRunnerPath();
  if (!(deps.exists ?? existsSync)(runnerPath)) return null;

  // Re-derive host-loopback support too: it was cached `false` if slirp4netns was absent at first
  // probe, which would keep the host-gateway rule off after an install until restart.
  resetEgressHostLoopbackCache();
  const version = await runCapture("slirp4netns", ["--version"]).catch(() => null);
  detectEgressHostLoopback({
    versionOutput: () => (version?.status === 0 ? version.output.trim() : null),
  });

  const mkdtemp = deps.mkdtemp ?? ((prefix: string) => mkdtempSync(prefix));
  const cleanup = deps.rmdir ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  const tmpDir = mkdtemp(join(tmpdir(), "shepherd-egress-probe-"));
  try {
    const inner = buildProbeInnerArgv(tmpDir, deps);
    const probe = await runCapture(runnerPath, ["--tmp", tmpDir, "--", ...inner]);
    if (probe.status === 0) return "slirp4netns";
    // The tail carries host paths, so it goes to the LOG, never into a diagnostics payload.
    console.warn(
      `[sandbox] egress self-test exits ${probe.status} — autonomous spawns will be refused:\n` +
        probe.output.trim().slice(-EGRESS_PROBE_DETAIL_MAX),
    );
    return null;
  } finally {
    try {
      cleanup(tmpDir);
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Re-probe the egress backend ASYNCHRONOUSLY and REFILL the per-process cache that the spawn paths
 * (`detectEgressBackend`, drain + service) read. Called by every DIAGNOSE check, so an operator who
 * installs the missing packages and hits Re-run un-blocks autonomous spawns without a restart, and
 * the row and the refusal decision never disagree.
 *
 * Same verdict rules as {@link detectEgressBackend}: all required tools present AND the full-nesting
 * self-test exits 0. A definitive answer (tool missing, runner missing, self-test non-zero) writes
 * the cache; a probe that could not complete (timeout, spawn error) REJECTS and leaves the cache as
 * it was — "couldn't check" must not flip a working host to refused.
 */
export async function refreshEgressBackend(
  deps: EgressRefreshDeps = {},
): Promise<EgressProbeFacts> {
  const runCapture = deps.runCapture ?? defaultEgressRunCapture;
  const results = await Promise.all(
    EGRESS_REQUIRED_TOOLS.map(async (tool) => ({
      tool,
      ok: (await runCapture(tool, ["--version"])).status === 0,
    })),
  );
  const missingTools = results.filter((r) => !r.ok).map((r) => r.tool);
  const backend = missingTools.length > 0 ? null : await runEgressSelfTest(deps, runCapture);
  _egressBackendCache = backend;
  return { backend, missingTools };
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
 * SHEPHERD_SANDBOX_EXTRA_HOSTS / the per-repo egressExtraHosts setting. The claude.ai
 * connector proxy is added per spawn by {@link connectorEgressHosts} when the repo opts in.
 */
export const ANTHROPIC_EGRESS_HOSTS: readonly string[] = [
  "api.anthropic.com",
  "statsig.anthropic.com",
] as const;

/** The host Claude Code reaches the claude.ai account connectors through. */
export const CLAUDEAI_CONNECTOR_EGRESS_HOST = "mcp-proxy.anthropic.com";

/**
 * Extra egress hosts a spawn needs for the claude.ai account connectors: the connector proxy, but
 * only when the repo opted in (`claudeAiConnectorsEnabled`) AND the spawn is a Claude task session.
 * Codex has no claude.ai connectors and the Operator Assistant never gets them, so neither widens
 * its allowlist.
 */
export function connectorEgressHosts(
  enabled: boolean,
  spawn: { agentProvider?: string; operatorAssistant?: boolean },
): string[] {
  if (!enabled || spawn.agentProvider === "codex" || spawn.operatorAssistant) return [];
  return [CLAUDEAI_CONNECTOR_EGRESS_HOST];
}

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

/** The netns tap address slirp4netns `--configure` assigns; `add_hostfwd` delivers here. */
export const SLIRP_GUEST_ADDR = "10.0.2.100";

/** Minimum slirp4netns version whose host-loopback (10.0.2.2 → host 127.0.0.1) we rely on.
 *  Human-readable source-of-truth: "1.0.0" — a broadly-available modern floor; below it we fall back
 *  to polling (see detectEgressHostLoopback). Module-private (only detectEgressHostLoopback uses it). */
const SLIRP4NETNS_HOSTLOOPBACK_MIN: [number, number, number] = [1, 0, 0];

/** The UDP source port dnsmasq sends its upstream queries from (`--query-port`). The nft rule
 *  that lets DNS reach {@link SLIRP_RESOLVER} matches it, so only dnsmasq — not the agent — can
 *  talk to the unfiltered upstream resolver (audit N06). MUST stay below 1024: the bwrap membrane
 *  drops CAP_NET_BIND_SERVICE, so the agent can't bind it to spoof the source port. */
export const DNSMASQ_QUERY_PORT = 1023;

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
 * The gate for `browserAllowedHosts` (via `validate.ts`); egress allowlist entries go
 * through {@link normalizeEgressEntry}, which applies the same hostname rule.
 */
export function normalizeHost(raw: string): string | null {
  const h = raw.trim().toLowerCase();
  if (!h) return null;
  if (!HOSTNAME_RE.test(h)) return null;
  return h;
}

// ── egress allowlist entries ──────────────────────────────────────────────────

/** The only port an entry without `:port` opens. */
const EGRESS_DEFAULT_PORT = 443;

/** `[*.]host[:port]`: an optional leading `*.` label, a host, an optional port without leading zero. */
const EGRESS_ENTRY_RE = /^(\*\.)?([^:*]+)(?::([1-9]\d{0,4}))?$/;
const IPV4_RE = /^\d+(\.\d+)+$/;

/** One parsed allowlist entry: `pattern` is an exact host or `*.host` (strict subdomains only). */
interface EgressEntry {
  pattern: string;
  port: number;
}

/**
 * Parse one egress allowlist entry (#3923): `host` (exactly that host), `*.host` (its subdomains,
 * not the host itself), each optionally with `:port` (that TCP port only; default 443). The host
 * part must pass {@link HOSTNAME_RE}, so `*.com` (wildcard over one label) is refused, as is a
 * wildcard over an IP. Returns null to reject.
 */
function parseEgressEntry(raw: string): EgressEntry | null {
  const m = EGRESS_ENTRY_RE.exec(raw.trim().toLowerCase());
  if (!m) return null;
  const [, wildcard, host, portText] = m;
  if (!HOSTNAME_RE.test(host!)) return null;
  if (wildcard && IPV4_RE.test(host!)) return null;
  const port = portText === undefined ? EGRESS_DEFAULT_PORT : Number(portText);
  if (port > 65535) return null;
  return { pattern: (wildcard ?? "") + host, port };
}

/**
 * Normalize an egress allowlist entry to its stored form (lowercase, trimmed, `:443` dropped), or
 * null to reject. The SINGLE gate for what may enter the egress allowlist; `validate.ts` reuses it
 * so a validated entry is exactly an enforced one.
 */
export function normalizeEgressEntry(raw: string): string | null {
  const e = parseEgressEntry(raw);
  if (!e) return null;
  return e.port === EGRESS_DEFAULT_PORT ? e.pattern : `${e.pattern}:${e.port}`;
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
    const entry = urlEgressEntry(cfg.baseUrl);
    if (entry) hosts.push(entry);
  }
  return hosts;
}

/**
 * A URL as an allowlist entry: its host, with its port when that isn't 443 (plain `http://`
 * without a port → `:80`), so a forge or registry on another port stays reachable under the
 * 443-only default. Null for a malformed URL or one whose host no entry can hold.
 */
export function urlEgressEntry(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const port = url.port || (url.protocol === "http:" ? "80" : "");
  return normalizeEgressEntry(port ? `${url.hostname}:${port}` : url.hostname);
}

/** Normalize, deduplicate, and sort a raw host list. */
function normalizeDedupeSort(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of raw) {
    const norm = normalizeEgressEntry(h);
    if (norm === null || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  out.sort();
  return out;
}

/**
 * Build the deduped, sorted egress allowlist of entries (see {@link parseEgressEntry}) for an
 * agent spawn.
 *
 *   - Anthropic base set: always included.
 *   - Forge hosts: every map KEY (the host); for `type === "github"` entries the
 *     GitHub well-known set is also added; for a `baseUrl`, its host (with a non-443 port).
 *     When `forges` is EMPTY (no entries), the GitHub well-known set is added as the
 *     default forge (Shepherd defaults to github.com via the `gh` CLI).
 *   - `extraHosts`: operator additions, appended verbatim (after normalization).
 *
 * Invalid entries (empty, non-hostname characters, no dot, bad port) are silently dropped.
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

// ── host matching ─────────────────────────────────────────────────────────────

/**
 * True when dnsmasq resolves `host` for some entry in `allowlist` — the drop-watcher's mirror of
 * {@link buildEgressConfig}: a plain entry matches only that exact host, `*.d` only strict
 * subdomains of `d`. The port is irrelevant to name resolution.
 */
export function hostMatchesAllowlist(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase();
  return allowlist.some((raw) => {
    const e = parseEgressEntry(raw);
    return e !== null && patternCovers(e.pattern, h);
  });
}

/**
 * True when some entry in `allowlist` opens `entry`'s host on `entry`'s port — the
 * port-aware check for "already allowed" (lockfile suggestions): `registry.corp:4873` is not
 * covered by a plain `registry.corp`, which only opens 443.
 */
export function egressEntryCovered(entry: string, allowlist: string[]): boolean {
  const target = parseEgressEntry(entry);
  if (!target) return false;
  return allowlist.some((raw) => {
    const e = parseEgressEntry(raw);
    return e !== null && e.port === target.port && patternCovers(e.pattern, target.pattern);
  });
}

/** Whether allowlist pattern `pattern` (`d` / `*.d`) covers `target` (a host or `*.host`). */
function patternCovers(pattern: string, target: string): boolean {
  if (!pattern.startsWith("*.")) return target === pattern;
  const base = pattern.slice(2);
  return target.endsWith(`.${base}`) || target === pattern;
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
 * @param allowlist  Deduped, sorted entry list (from buildEgressAllowlist).
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
    `--query-port=${DNSMASQ_QUERY_PORT}`,
  ];

  const groups = groupEgressEntries(allowlist);
  dnsmasqArgv.push(...dnsmasqDomainArgs(groups, resolver, nftSet));

  dnsmasqArgv.push(`--min-cache-ttl=${minCacheTtl}`);
  dnsmasqArgv.push("--log-queries");
  dnsmasqArgv.push(`--log-facility=${tmpDir}/dns.log`);

  // ── nft ruleset ─────────────────────────────────────────────────────────────
  // family inet, table egress, default-drop with explicit REJECT for fast-fail.
  // When hostGateway is set, ONE least-privilege allow for the host IP+port goes
  // right after the allowed-set accepts (return traffic is covered by ct established).
  // The resolver accept is bound to dnsmasq's fixed query port (see DNSMASQ_QUERY_PORT), and TCP 53
  // is not opened at all: either would let the agent query the upstream resolver directly and
  // bypass the allowlist (audit N06). Cost: no TCP fallback for a truncated upstream answer.
  // Table `devfwd`: the only new inbound connections on tap0 are slirp hostfwds Shepherd adds
  // for the session's dev port (#2889); DNAT them to the netns loopback so a dev server bound
  // to 127.0.0.1 is reachable too (needs tap0 route_localnet, set by the runner).
  // Allowed IPs are open on ONE TCP port each (#3923): set `allowed` on 443, set `allowed_p<N>`
  // on N for every `host:N` entry.
  const ports = [...new Set([EGRESS_DEFAULT_PORT, ...[...groups.values()].flat()])].sort(
    (a, b) => a - b,
  );
  const sets = ports
    .map((p) => `  set ${portSetName("allowed", p)} {\n    type ipv4_addr\n    flags timeout\n  }`)
    .join("\n");
  const allowRules = ports
    .map((p) => `    ip daddr @${portSetName("allowed", p)} tcp dport ${p} accept`)
    .join("\n");
  const hostGatewayRule = hostGateway
    ? `\n    ip daddr ${hostGateway.ip} tcp dport ${hostGateway.port} accept`
    : "";
  const nftRuleset = `table inet egress {
${sets}
  chain out {
    type filter hook output priority 0; policy drop;
    oifname "lo" accept
    ct state established,related accept
    ip daddr ${resolver} udp sport ${DNSMASQ_QUERY_PORT} udp dport 53 accept
${allowRules}${hostGatewayRule}
    meta nfproto ipv6 reject
    meta l4proto tcp reject with tcp reset
    reject
  }
}
table ip devfwd {
  chain pre {
    type nat hook prerouting priority -100;
    iifname "tap0" ip daddr ${SLIRP_GUEST_ADDR} dnat to 127.0.0.1
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

/** The nft set carrying the IPs open on `port`: `base` for 443, `base_p<port>` otherwise. */
function portSetName(base: string, port: number): string {
  return port === EGRESS_DEFAULT_PORT ? base : `${base}_p${port}`;
}

/** Valid entries grouped by pattern (`d` / `*.d`) → its ports, ascending, in allowlist order. */
function groupEgressEntries(allowlist: string[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const raw of allowlist) {
    const e = parseEgressEntry(raw);
    if (!e) continue;
    const ports = groups.get(e.pattern) ?? [];
    if (!ports.includes(e.port)) ports.push(e.port);
    groups.set(
      e.pattern,
      ports.sort((a, b) => a - b),
    );
  }
  return groups;
}

/** Ports of every wildcard entry `*.Y` covering `domain`, i.e. with `Y` a strict ancestor of it. */
function coveringWildcardPorts(groups: Map<string, number[]>, domain: string): number[] {
  const ports: number[] = [];
  for (const [pattern, p] of groups) {
    if (pattern.startsWith("*.") && domain.endsWith(pattern.slice(1))) ports.push(...p);
  }
  return ports;
}

/**
 * The per-pattern dnsmasq flags. dnsmasq picks the LONGEST matching domain for both `--server`
 * and `--nftset`, so every exact/wildcard pair along one name chain has to be reconciled.
 *
 * Resolution: `--server=/d/` matches `d` AND every subdomain, so an exact pattern `d` also gets
 * `--server=/*.d/` with no upstream: dnsmasq answers its subdomains NXDOMAIN locally (verified on
 * dnsmasq 2.93, pinned by test/egress-dns-match.test.ts — the more specific `/*.d/` beats `/d/`,
 * and an exact `api.d` or wildcard `*.x.d` still beats `/*.d/`). Skipped when `*.d` or a wildcard
 * over an ancestor of `d` is an entry: that wildcard already covers every subdomain of `d`.
 *
 * Pinning: `--nftset` ignores the `*.` syntax and matches by suffix, so `--nftset=/d/` serves `d`
 * and `*.d`, and is the longest match for every name under `d` without a deeper pin. Each pin
 * therefore carries the ports of `d`, of `*.d`, and of every wildcard over an ancestor of `d`.
 * Cost: names at and under `d` share one pin — `d` also gets `*.d`'s ports, and `d`'s subdomains
 * get the ports of an exact `d` entry.
 */
function dnsmasqDomainArgs(
  groups: Map<string, number[]>,
  resolver: string,
  nftSet: string,
): string[] {
  const args: string[] = [];
  const pins = new Map<string, Set<number>>();
  for (const [pattern, ports] of groups) {
    args.push(`--server=/${pattern}/${resolver}`);
    const wildcard = pattern.startsWith("*.");
    const domain = wildcard ? pattern.slice(2) : pattern;
    const covering = coveringWildcardPorts(groups, domain);
    if (!wildcard && !groups.has(`*.${domain}`) && covering.length === 0) {
      args.push(`--server=/*.${domain}/`);
    }
    pins.set(domain, new Set([...(pins.get(domain) ?? []), ...ports, ...covering]));
  }
  for (const [domain, ports] of pins) {
    const sets = [...ports].sort((a, b) => a - b).map((p) => portSetName(nftSet, p));
    args.push(`--nftset=/${domain}/${sets.join(",")}`);
  }
  return args;
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
  /** Host uid/gid the agent is mapped back to (default process.getuid()/getgid()). */
  uid?: number;
  gid?: number;
}

const RESOLV_CONF = "/etc/resolv.conf";
const NSSWITCH_CONF = "/etc/nsswitch.conf";

/**
 * Returns ADDITIVE bwrap flags to append AFTER the membrane flags.
 *
 * - `--unshare-user --uid <host uid> --gid <host gid>` — egress-runner execs bwrap inside
 *   `unshare --map-root-user`, i.e. as uid 0. A nested user namespace maps the agent back to the
 *   operator's real ids; claude refuses `--dangerously-skip-permissions` as root and would exit
 *   at launch.
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
    "--unshare-user",
    "--uid",
    String(deps.uid ?? process.getuid?.() ?? 0),
    "--gid",
    String(deps.gid ?? process.getgid?.() ?? 0),
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

/** slirp4netns API socket the runner opens in the session's egress temp dir (#2889). */
export function egressApiSocketPath(sessionId: string): string {
  return join(egressTmpDir(sessionId), "slirp.sock");
}

/** PID file the runner writes: a process inside the session's netns (#2889). */
export function egressNetnsPidPath(sessionId: string): string {
  return join(egressTmpDir(sessionId), "netns.pid");
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
  // A reload script left from an earlier spawn of this session must never reach the new runner.
  rmSync(join(tmpDir, "egress.reload.nft"), { force: true });
}

// ── live reload (allowlist edits reach running sessions) ───────────────────────

/**
 * The nft script the runner's reload loop applies (`nft -f`, one atomic transaction) to swap a
 * running session's ruleset for `cfg`'s. `flushPinned` (an entry was removed) drops both tables
 * first, so IPs pinned for removed hosts are revoked. Otherwise the chains are emptied and the
 * full ruleset re-declared on top: nft merges a declaration into an existing table, so existing
 * sets keep their pinned IPs, new port sets are created and the rules land in the empty chains.
 */
export function buildEgressReloadNft(cfg: EgressConfig, opts: { flushPinned: boolean }): string {
  const prefix = opts.flushPinned
    ? "delete table inet egress\ndelete table ip devfwd\n"
    : [
        "add table inet egress",
        "add chain inet egress out { type filter hook output priority 0; policy drop; }",
        "flush chain inet egress out",
        "add table ip devfwd",
        "add chain ip devfwd pre { type nat hook prerouting priority -100; }",
        "flush chain ip devfwd pre",
        "",
      ].join("\n");
  return prefix + cfg.nftRuleset;
}

/** Write the reload artefacts: the reload nft script plus the new dnsmasq argv + ruleset. Sync
 *  (tiny files) so a caller can check {@link readEgressSpawnId} and write in one loop tick, with
 *  no respawn of the session slipping in between. */
export function writeEgressReloadFiles(tmpDir: string, cfg: EgressConfig, reloadNft: string): void {
  writeFileSync(join(tmpDir, "egress.reload.nft"), reloadNft, "utf8");
  writeFileSync(join(tmpDir, "dnsmasq.argv"), cfg.dnsmasqArgv.join("\n"), "utf8");
  writeFileSync(join(tmpDir, "egress.nft"), cfg.nftRuleset, "utf8");
}

/** How a live reload request ended. `unsupported`: no reload loop listening (a runner from
 *  before live reload, or the netns is gone). */
export type EgressReloadOutcome = "applied" | "failed" | "unsupported" | "timeout";

export interface EgressReloadDeps {
  /** Hand `line` to the FIFO without blocking; throws ENOENT/ENXIO when nobody listens. */
  signal?: (fifo: string, line: string) => Promise<void>;
  readStatus?: (path: string) => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

const RELOAD_POLL_MS = 100;
const RELOAD_TIMEOUT_MS = 5_000;
let reloadSeq = 0;

async function defaultSignal(fifo: string, line: string): Promise<void> {
  // O_NONBLOCK: opening a FIFO with no reader fails ENXIO instead of hanging the loop.
  const fh = await fsp.open(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
  try {
    await fh.write(line);
  } finally {
    await fh.close();
  }
}

async function defaultReadStatus(path: string): Promise<string | null> {
  try {
    return (await fsp.readFile(path, "utf8")).slice(0, 200);
  } catch {
    return null;
  }
}

/** Ask the session's runner to reload its firewall from the files {@link writeEgressReloadFiles}
 *  wrote, and wait (async) for its `<seq> ok|fail` status. */
export async function requestEgressReload(
  tmpDir: string,
  deps: EgressReloadDeps = {},
): Promise<EgressReloadOutcome> {
  const signal = deps.signal ?? defaultSignal;
  const readStatus = deps.readStatus ?? defaultReadStatus;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const seq = `${process.pid}-${Date.now()}-${++reloadSeq}`;
  try {
    await signal(join(tmpDir, "reload.fifo"), `${seq}\n`);
  } catch {
    return "unsupported";
  }
  const statusPath = join(tmpDir, "reload.status");
  const timeoutMs = deps.timeoutMs ?? RELOAD_TIMEOUT_MS;
  for (let waited = 0; waited < timeoutMs; waited += RELOAD_POLL_MS) {
    await sleep(RELOAD_POLL_MS);
    const [gotSeq, result] = (await readStatus(statusPath))?.trim().split(" ") ?? [];
    if (gotSeq === seq) return result === "ok" ? "applied" : "failed";
  }
  return "timeout";
}

/** What a session's egress spawn was built from, so a live reload can rebuild the same config
 *  with a changed allowlist. Persisted as `egress-spawn.json` in the session's egress tmp dir. */
export interface EgressSpawnInputs {
  /** Fresh per spawn: a reapply that sees it change knows the session was respawned meanwhile. */
  spawnId: string;
  repoPath: string;
  hostGateway?: { ip: string; port: number };
  connectorHosts: string[];
  /** The allowlist currently applied to the session. */
  allowlist: string[];
  /** A reload timed out or failed part-way, so what the session runs is unknown: the next reapply
   *  must reload (dropping pinned IPs) even when `allowlist` matches the wanted list. */
  uncertain?: boolean;
}

const SPAWN_INPUTS_FILE = "egress-spawn.json";
const MAX_SPAWN_INPUTS_BYTES = 256 * 1024;

/** Sync, like {@link writeEgressConfigFiles} it sits beside in the spawn path (tiny file). */
export function writeEgressSpawnInputs(tmpDir: string, inputs: EgressSpawnInputs): void {
  writeFileSync(join(tmpDir, SPAWN_INPUTS_FILE), JSON.stringify(inputs), "utf8");
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

function isHostGateway(v: unknown): v is { ip: string; port: number } {
  if (v === undefined) return true;
  const g = v as { ip?: unknown; port?: unknown } | null;
  return (
    typeof g === "object" && g !== null && typeof g.ip === "string" && Number.isInteger(g.port)
  );
}

/** The spawn id in the session's `egress-spawn.json`, or null. Sync, for the check-then-write a
 *  reapply does in one loop tick (see {@link writeEgressReloadFiles}). */
export function readEgressSpawnId(tmpDir: string): string | null {
  try {
    const raw = readFileSync(join(tmpDir, SPAWN_INPUTS_FILE), "utf8");
    if (raw.length > MAX_SPAWN_INPUTS_BYTES) return null;
    const id = (JSON.parse(raw) as { spawnId?: unknown }).spawnId;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/** The session's {@link EgressSpawnInputs}, or null when absent or malformed. */
export async function readEgressSpawnInputs(tmpDir: string): Promise<EgressSpawnInputs | null> {
  try {
    const raw = await fsp.readFile(join(tmpDir, SPAWN_INPUTS_FILE), "utf8");
    if (raw.length > MAX_SPAWN_INPUTS_BYTES) return null;
    const v = JSON.parse(raw) as Partial<EgressSpawnInputs>;
    const ok =
      typeof v.spawnId === "string" &&
      typeof v.repoPath === "string" &&
      isStringArray(v.connectorHosts) &&
      isStringArray(v.allowlist) &&
      isHostGateway(v.hostGateway) &&
      (v.uncertain === undefined || typeof v.uncertain === "boolean");
    return ok ? (v as EgressSpawnInputs) : null;
  } catch {
    return null;
  }
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
