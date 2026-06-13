/**
 * Host-derived bubblewrap (`bwrap`) sandbox membrane for spawned task agents.
 *
 * Self-contained + dependency-injectable: it imports NO store/service/server (no
 * cycles) and every host touch (process spawn, fs existence) is an
 * injectable dep so tests never spawn bwrap or depend on the runner's host.
 *
 * Three profiles gate how a spawned `claude` is wrapped:
 *   - trusted    — legacy: NO sandbox, runs unconfined (passthrough). auto allowed.
 *   - standard   — wrapped in the bwrap membrane; auto refused (interactive only).
 *   - autonomous — wrapped in the membrane; auto allowed iff a backend is present.
 *
 * The membrane is a frozen, host-derived flag list validated against real
 * claude 2.1.173 on the reference host (see buildMembraneFlags). It uses
 * `*-bind-try` for every host-variable path so an absent source is skipped
 * rather than hard-failing the spawn.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "./instrument";
import { resolveNodeBin } from "./node-bin";
import type { EgressBackend } from "./egress";

/** realpath that falls back to the input on any error (broken/missing path). */
export function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// ── profiles ────────────────────────────────────────────────────────────────

export type SandboxProfile = "trusted" | "standard" | "autonomous";

export const SANDBOX_PROFILES: readonly SandboxProfile[] = [
  "trusted",
  "standard",
  "autonomous",
] as const;

export function isSandboxProfile(v: unknown): v is SandboxProfile {
  return typeof v === "string" && (SANDBOX_PROFILES as readonly string[]).includes(v);
}

/** Per-spawn override ?? repo setting ?? global default. Invalid/blank => fall through. */
export function resolveProfile(
  override: string | null | undefined,
  repoSetting: string | null | undefined,
  defaultProfile: SandboxProfile,
): SandboxProfile {
  const ov = typeof override === "string" ? override.trim() : "";
  if (isSandboxProfile(ov)) return ov;
  const rs = typeof repoSetting === "string" ? repoSetting.trim() : "";
  if (isSandboxProfile(rs)) return rs;
  return defaultProfile;
}

// ── backend ──────────────────────────────────────────────────────────────────

export type SandboxBackend = "bwrap" | null;

/** Injectable host probes shared by detection + flag construction. */
export interface PathProbeDeps {
  /** Run a command; default uses the repo-wrapped execFileSync. Returns its exit status. */
  run?: (cmd: string, args: string[]) => { status: number };
  /** Existence probe; default fs.existsSync. */
  exists?: (p: string) => boolean;
}

/** detectBackend additionally needs a probe environment to build a self-test membrane. */
export interface BackendProbeDeps extends PathProbeDeps {
  home?: string;
  claudeDir?: string;
  nodeBinReal?: string;
}

/** Default `run`: spawn via the regression-guarded wrapper, mapping to {status}. */
export function defaultRun(cmd: string, args: string[]): { status: number } {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return { status: 0 };
  } catch (e) {
    const status = (e as { status?: number } | null)?.status;
    return { status: typeof status === "number" ? status : 1 };
  }
}

let _backendCache: SandboxBackend | undefined;

/** Clear the per-process backend cache (tests). */
export function resetBackendCache(): void {
  _backendCache = undefined;
}

/**
 * Detect the sandbox backend with a real per-host SELF-TEST (cached per process).
 *
 * Not merely `bwrap --version`: kernel/user-namespace policy can let bwrap exist
 * yet refuse to actually create a sandbox (e.g. unprivileged userns disabled). So
 * the probe builds the real derived membrane around BOTH `node --version` AND a
 * `git` invocation and runs it; only an exit 0 proves a usable backend.
 *
 * Available ("bwrap") iff `bwrap --version` exits 0 AND the wrapped probe exits 0.
 */
export function detectBackend(deps: BackendProbeDeps = {}): SandboxBackend {
  if (_backendCache !== undefined) return _backendCache;

  const run = deps.run ?? defaultRun;
  // 1. bwrap present at all?
  if (run("bwrap", ["--version"]).status !== 0) {
    _backendCache = null;
    return _backendCache;
  }

  // 2. Self-test: build a real membrane around a trivial node+git probe and run it.
  // A small fixed probe input — a tmp dir stands in for worktree/repo. Anything
  // exit-0 through the membrane proves the backend can actually create a sandbox.
  const home = deps.home ?? process.env.HOME ?? "/root";
  const claudeDir = deps.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? `${home}/.claude`;
  const nodeBinReal = deps.nodeBinReal ?? safeRealpath(resolveNodeBin());
  const probeDir = "/tmp";
  const membrane: MembraneInputs = {
    worktreePath: probeDir,
    gitCommonDir: probeDir,
    isolated: false,
    repoPath: probeDir,
    claudeDir,
    home,
    nodeBinReal,
  };
  const flags = buildMembraneFlags(membrane, deps);
  // chain `node --version && git --version` inside the sandbox via /bin/sh -c.
  const probe = run("bwrap", [...flags, "--", "/bin/sh", "-c", "node --version && git --version"]);

  _backendCache = probe.status === 0 ? "bwrap" : null;
  return _backendCache;
}

// ── membrane flag construction ────────────────────────────────────────────────

export interface MembraneInputs {
  worktreePath: string;
  /** ABSOLUTE shared object store (the worktree's `.git` is a file pointing here). */
  gitCommonDir: string;
  /** false => session runs in repoPath (bind repoPath rw) instead of worktree+common. */
  isolated: boolean;
  repoPath: string;
  /** CLAUDE_CONFIG_DIR ?? ~/.claude (caller passes resolved). */
  claudeDir: string;
  home: string;
  /** realpath of resolveNodeBin() (caller passes resolved). */
  nodeBinReal: string;
  term?: string;
  /** Non-secret host env vars to pass through under `--clearenv` (e.g. LANG/TZ);
   *  caller builds this via `collectPassthroughEnv`. HOME/PATH/TERM are always set
   *  separately and must NOT be included here. */
  extraEnv?: Record<string, string>;
}

/**
 * Env vars allowed through the `--clearenv` membrane: locale/display only, never
 * credentials. The membrane clears ALL inherited env (so GH_TOKEN, SHEPHERD_TOKEN,
 * ANTHROPIC_*, AWS_*, etc. cannot leak into a hijacked agent) and re-sets only
 * HOME/PATH/TERM plus whichever of these are present on the host.
 */
const SANDBOX_ENV_PASSTHROUGH = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  "COLORTERM",
] as const;

/** Pick the non-secret passthrough vars that are actually set in `env`. */
export function collectPassthroughEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SANDBOX_ENV_PASSTHROUGH) {
    const v = env[k];
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  // claude emits UTF-8; guarantee a sane locale even when the host sets none.
  if (out.LANG === undefined && out.LC_ALL === undefined) out.LANG = "C.UTF-8";
  return out;
}

// Known version-manager / package-manager roots whose presence (as a prefix of
// nodeBinReal, or merely existing) means we must bind that whole tree RO so the
// node binary's libs/launchers resolve inside the sandbox.
function managerRoots(home: string): string[] {
  return [
    "/home/linuxbrew/.linuxbrew",
    `${home}/.local/share/mise`,
    `${home}/.nvm`,
    `${home}/.local/share/fnm`,
  ];
}

/**
 * Compute the RO toolchain binds for the node binary. Always binds the binary's
 * own directory; additionally binds any known manager root that is a PREFIX of
 * nodeBinReal OR exists on the host. De-dupes so the same path isn't bound twice
 * and a child of an already-bound root is skipped.
 */
function nodeToolchainFlags(inputs: MembraneInputs, exists: (p: string) => boolean): string[] {
  const binDir = dirname(inputs.nodeBinReal);
  const added: string[] = [];
  const flags: string[] = [];
  const isUnder = (p: string, root: string) => p === root || p.startsWith(root + "/");
  const add = (p: string) => {
    if (added.some((a) => a === p || isUnder(p, a))) return; // already bound or under a bound root
    added.push(p);
    flags.push("--ro-bind-try", p, p);
  };

  // Manager roots first so a binDir under one of them is de-duped away.
  for (const root of managerRoots(inputs.home)) {
    if (isUnder(inputs.nodeBinReal, root) || exists(root)) add(root);
  }
  add(binDir);
  return flags;
}

/**
 * The frozen, host-derived membrane flag list (validated against real claude
 * 2.1.173 on the reference host). Returns the bwrap argv PREFIX flags only —
 * `wrapArgv` appends `-- <innerArgv>`.
 *
 * Every host-variable path uses `*-bind-try` so an absent source is SKIPPED, not
 * a hard fail. Only paths guaranteed to exist on any Linux host (/usr, /etc) use
 * a plain `--ro-bind`.
 */
export function buildMembraneFlags(inputs: MembraneInputs, deps: PathProbeDeps = {}): string[] {
  const exists = deps.exists ?? existsSync;
  const home = inputs.home;
  const claudeDir = inputs.claudeDir;
  const term = inputs.term ?? "xterm-256color";

  const f: string[] = [
    // ── base read-only root ──────────────────────────────────────────────
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/etc",
    "/etc",
    "--ro-bind-try",
    "/opt",
    "/opt",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib",
    "/lib64",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/bin",
    "/sbin",
    // ── kernel/process surfaces ──────────────────────────────────────────
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    home,
    // DNS: /etc/resolv.conf symlinks here on systemd-resolved hosts; no-op elsewhere.
    "--ro-bind-try",
    "/run/systemd/resolve",
    "/run/systemd/resolve",
    // ── claude config: base RO (auth + commands + skills) ────────────────
    "--ro-bind",
    claudeDir,
    claudeDir,
    // RW: agent writes transcript; host reads it after.
    "--bind",
    `${claudeDir}/projects`,
    `${claudeDir}/projects`,
    "--bind-try",
    `${claudeDir}/todos`,
    `${claudeDir}/todos`,
    "--bind-try",
    `${claudeDir}/statsig`,
    `${claudeDir}/statsig`,
    "--bind-try",
    `${claudeDir}/shell-snapshots`,
    `${claudeDir}/shell-snapshots`,
    // RW: OAuth token refresh writes back.
    "--bind-try",
    `${claudeDir}/.credentials.json`,
    `${claudeDir}/.credentials.json`,
    // RW persisted: trust/onboarding state (else non-interactive auto hangs on onboarding).
    "--bind-try",
    `${home}/.claude.json`,
    `${home}/.claude.json`,
    // claude native binary + launcher symlink.
    "--ro-bind-try",
    `${home}/.local/share/claude`,
    `${home}/.local/share/claude`,
    "--ro-bind-try",
    `${home}/.local/bin`,
    `${home}/.local/bin`,
  ];

  // ── node toolchain (binary's libs must resolve) ──────────────────────────
  f.push(...nodeToolchainFlags(inputs, exists));

  // ── commit identity + gh token ───────────────────────────────────────────
  f.push("--ro-bind-try", `${home}/.gitconfig`, `${home}/.gitconfig`);
  f.push("--ro-bind-try", `${home}/.config/gh`, `${home}/.config/gh`);

  // ── worktree / git store ─────────────────────────────────────────────────
  if (inputs.isolated) {
    // worktree (rw) + the ABSOLUTE shared object store (rw).
    f.push("--bind", inputs.worktreePath, inputs.worktreePath);
    f.push("--bind", inputs.gitCommonDir, inputs.gitCommonDir);
  } else {
    // whole repo (its .git is inside).
    f.push("--bind", inputs.repoPath, inputs.repoPath);
  }

  // ── env + process hardening ──────────────────────────────────────────────
  // Clear ALL inherited env first, then re-set only what a compliant session needs.
  // This is what keeps env-resident secrets (GH_TOKEN, SHEPHERD_TOKEN, ANTHROPIC_*,
  // AWS_*, …) out of a hijacked agent — they would otherwise be inherited verbatim.
  const nodeBinDir = dirname(inputs.nodeBinReal);
  f.push("--clearenv");
  f.push("--setenv", "HOME", home);
  f.push("--setenv", "PATH", `${home}/.local/bin:${nodeBinDir}:/usr/bin:/bin`);
  f.push("--setenv", "TERM", term);
  // --clearenv strips CLAUDE_CONFIG_DIR; re-set it when the bound config dir is NOT the
  // default ~/.claude, else claude would fall back to an empty ~/.claude tmpfs (the custom
  // dir IS bound above) and lose auth/onboarding state.
  if (claudeDir !== `${home}/.claude`) f.push("--setenv", "CLAUDE_CONFIG_DIR", claudeDir);
  for (const [k, v] of Object.entries(inputs.extraEnv ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    f.push("--setenv", k, v);
  }
  f.push(
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
    "--cap-drop",
    "ALL",
  );

  return f;
}

/**
 * Wrap an inner claude argv with the bwrap prefix for the given profile + backend.
 * trusted OR backend===null => returns innerArgv UNCHANGED (passthrough/degrade).
 */
export function wrapArgv(
  innerArgv: string[],
  opts: { profile: SandboxProfile; backend: SandboxBackend; membrane: MembraneInputs },
  deps: PathProbeDeps = {},
): string[] {
  if (opts.profile === "trusted" || opts.backend === null) return innerArgv;
  return ["bwrap", ...buildMembraneFlags(opts.membrane, deps), "--", ...innerArgv];
}

// ── auto-gate ─────────────────────────────────────────────────────────────────

/** Refuse reason emitted when slirp4netns/dnsmasq/nft stack is absent for an autonomous spawn. */
export const EGRESS_UNAVAILABLE_REASON =
  "Autonomous spawn refused: network-egress backend unavailable (slirp4netns/dnsmasq/nft).";

/**
 * Returns a hold reason when an auto=true spawn must be refused, else null.
 *   trusted   -> null  (legacy: caller shows an "unconfined autonomy" banner)
 *   standard  -> ALWAYS refuse
 *   autonomous + backend null    -> refuse (no FS backend)
 *   autonomous + egressBackend null (explicitly passed) -> refuse (no egress backend)
 *   autonomous + backend present + egressBackend present-or-omitted -> null
 *
 * `egressBackend` is OPTIONAL for backward compatibility: existing callers that
 * pass only two args get identical behavior to before (undefined = "not considered").
 * Only an explicit `null` triggers the egress refuse path.
 */
export function autoHoldReason(
  profile: SandboxProfile,
  backend: SandboxBackend,
  egressBackend?: EgressBackend,
): string | null {
  if (profile === "trusted") return null;
  if (profile === "standard") {
    return "Autonomous spawn requires the autonomous profile (standard is interactive-only).";
  }
  // autonomous
  if (backend === null) {
    return "Autonomous spawn refused: no sandbox backend available.";
  }
  if (egressBackend === null) {
    return EGRESS_UNAVAILABLE_REASON;
  }
  return null;
}

/** Thrown when an auto spawn is refused (auto hold reason present). */
export class SandboxAutoRefused extends Error {
  readonly holdReason: string;
  constructor(holdReason: string) {
    super(holdReason);
    this.name = "SandboxAutoRefused";
    this.holdReason = holdReason;
  }
}

/**
 * Whether a degrade banner is warranted: a sandboxed profile (standard|autonomous)
 * was requested but no backend is available.
 */
export function isDegraded(profile: SandboxProfile, backend: SandboxBackend): boolean {
  return profile !== "trusted" && backend === null;
}

/**
 * Whether an egress-degraded banner is warranted for an INTERACTIVE autonomous
 * session: the FS sandbox is in place (backend present) but the network-egress
 * containment is absent (egressBackend null).
 *
 * Distinct from `isDegraded` (FS-backend-missing). Only meaningful for the
 * `autonomous` profile; standard/trusted return false regardless.
 */
export function isEgressDegraded(
  profile: SandboxProfile,
  backend: SandboxBackend,
  egressBackend: EgressBackend,
): boolean {
  return profile === "autonomous" && backend !== null && egressBackend === null;
}

/**
 * Whether the egress firewall applies to this profile at all.
 * Only `autonomous` sessions are egress-confined; trusted and standard are not.
 * Use this to decide whether to detect and wire the egress backend.
 */
export function egressApplies(profile: SandboxProfile): boolean {
  return profile === "autonomous";
}
