/**
 * Host-derived bubblewrap (`bwrap`) sandbox membrane for spawned task agents.
 *
 * Self-contained + dependency-injectable: it imports NO store/service/server (no
 * cycles) and every host touch (process spawn, fs existence) is an
 * injectable dep so tests never spawn bwrap or depend on the runner's host.
 *
 * Three profiles gate how a spawned `claude` is wrapped:
 *   - trusted    — NO sandbox, runs unconfined (passthrough). auto allowed.
 *   - standard   — wrapped in the bwrap membrane; auto refused (interactive only). The built-in
 *                  default where a backend works (#2100, see effectiveDefaultProfile).
 *   - autonomous — wrapped in the membrane; auto allowed iff a backend is present.
 *
 * The membrane is a frozen, host-derived flag list validated against real
 * claude 2.1.173 on the reference host (see buildMembraneFlags). It uses
 * `*-bind-try` for every host-variable path so an absent source is skipped
 * rather than hard-failing the spawn.
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { AGENT_SHELL_MARKERS } from "./agent-shell-env";
import { claudeConfigPath, dashify } from "./claude-trust";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "./instrument";
import { CODEX_ROLE_SCHEMA_DIR } from "./codex-role-output-schema";
import { resolveNodeBin } from "./node-bin";
import { resolveWorktreePinSync } from "./safe-git";
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

/** A repo's stored setting: a profile, or `"inherit"` = follow the global default (#2100). */
export type RepoSandboxSetting = SandboxProfile | "inherit";

export function isRepoSandboxSetting(v: unknown): v is RepoSandboxSetting {
  return v === "inherit" || isSandboxProfile(v);
}

/**
 * The global default profile (#2100): the operator's explicit SHEPHERD_SANDBOX_DEFAULT_PROFILE
 * wins; unset, it is `standard` where the bwrap backend works and `trusted` where it doesn't
 * (macOS, missing bwrap, userns off) — so a host that can't sandbox doesn't flag every session
 * degraded. `detect` only runs when there is no explicit choice.
 */
export function effectiveDefaultProfile(
  explicit: SandboxProfile | null,
  detect: () => SandboxBackend,
): SandboxProfile {
  return explicit ?? (detect() !== null ? "standard" : "trusted");
}

/** Per-spawn override ?? repo setting ?? global default. Invalid/blank/"inherit" => fall through.
 *  A function default is only called on fall-through, so an explicit profile never pays the
 *  backend self-test the built-in default needs (#2100). */
export function resolveProfile(
  override: string | null | undefined,
  repoSetting: string | null | undefined,
  defaultProfile: SandboxProfile | (() => SandboxProfile),
): SandboxProfile {
  const ov = typeof override === "string" ? override.trim() : "";
  if (isSandboxProfile(ov)) return ov;
  const rs = typeof repoSetting === "string" ? repoSetting.trim() : "";
  if (isSandboxProfile(rs)) return rs;
  return typeof defaultProfile === "function" ? defaultProfile() : defaultProfile;
}

// ── backend ──────────────────────────────────────────────────────────────────

export type SandboxBackend = "bwrap" | null;

/** Injectable host probes shared by detection + flag construction. */
export interface PathProbeDeps {
  /** Run a command; default uses the repo-wrapped execFileSync. Returns its exit status. */
  run?: (cmd: string, args: string[]) => { status: number };
  /** Existence probe; default fs.existsSync. */
  exists?: (p: string) => boolean;
  /** Directory listing; default a safe readdirSync wrapper returning [] on error. */
  readdir?: (p: string) => string[];
  /** Host-side git-store prep for the membrane's carve-outs; default {@link hostGitStore}. */
  gitStore?: GitStoreDeps;
}

export interface GitStoreDeps {
  /** Ensure `<store>/commondir` exists and resolves to the store itself; throws otherwise. */
  pinCommondir(store: string): void;
  /** Ensure `<dir>/config.worktree` exists as a regular file (empty when created); throws
   *  otherwise. */
  ensureWorktreeConfig(dir: string): void;
  /** The worktree's own admin dir under `<store>/worktrees` (trusted backlink match).
   *  @throws UntrustedGitDirError when none matches. */
  adminDir(repoPath: string, worktreePath: string): string | null;
}

/**
 * Git honors a `commondir` file in ANY gitdir and then reads `<target>/config`, so the store's own
 * must exist (to be bound RO) yet stay a no-op: "." names the store itself. An empty one would make
 * host git die, so it is written on the host before the spawn, never stubbed by bwrap.
 */
const hostGitStore: GitStoreDeps = {
  pinCommondir(store) {
    const file = join(store, "commondir");
    try {
      writeFileSync(file, ".\n", { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const target = resolve(store, readFileSync(file, "utf8").trim());
    if (realpathSync(target) !== realpathSync(store)) {
      throw new Error(`git store ${store}: commondir points outside the store`);
    }
  },
  // A `/dev/null` stub won't do: bwrap binds are nodev, so git can't open it and dies.
  ensureWorktreeConfig(dir) {
    const file = join(dir, "config.worktree");
    try {
      writeFileSync(file, "", { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (!lstatSync(file).isFile()) throw new Error(`git dir ${dir}: config.worktree not a file`);
  },
  adminDir: (repoPath, worktreePath) =>
    resolveWorktreePinSync(repoPath, worktreePath)?.gitDir ?? null,
};

/** readdirSync that returns [] on any error (missing dir, perms). */
function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
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
 *
 * DO NOT add `claude --version` (or codex) to this probe — issue #2111 exists because that is the
 * obvious-looking fix and it is the wrong one. This function's `null` means RUN UNCONFINED, so a
 * launcher fault folded in here would silently strip the sandbox from around untrusted plan text on
 * precisely the hosts that CAN sandbox. "Does the agent binary start inside the membrane" is a
 * separate, orthogonal question, answered by `probeMembraneLaunch` (membrane-launch.ts), whose
 * failure blocks the wrapped spawn and lights a DIAGNOSE row without touching confinement.
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
  // The mkdir exercises the session-env carve-out specifically: if the --tmpfs for
  // session-env is missing/regressed, the mkdir hits EROFS and the probe exits non-zero,
  // degrading the backend to null and surfacing the regression loudly.
  const probe = run("bwrap", [
    ...flags,
    "--",
    "/bin/sh",
    "-c",
    `node --version && git --version && mkdir -p '${claudeDir}/session-env/.shepherd-probe'`,
  ]);

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
  /** Real bun binary (config.bunBin, #3351): its dir is bound RO + put on PATH. null/absent = none. */
  bunBinReal?: string | null;
  term?: string;
  /** Non-secret host env vars to pass through under `--clearenv` (e.g. LANG/TZ);
   *  caller builds this via `collectPassthroughEnv`. HOME/PATH/TERM are always set
   *  separately and must NOT be included here. */
  extraEnv?: Record<string, string>;
  /** api-key mode: bind this helper script RO so claude can exec it. RESIDUAL:
   *  cat-able by an in-sandbox agent (host hygiene only, same class as audit R3/R4)
   *  — NOT in-membrane secrecy. */
  apiKeyHelperPath?: string | null;
  /** Absolute host paths that must ALSO exist inside the sandbox for a Shepherd-injected
   *  capability to work there (issue #2002): the PreToolUse tool-guard script, and the
   *  agent-skills directory passed via `--add-dir`. Bound RO at the same path, like
   *  `apiKeyHelperPath`. Load-bearing, not cosmetic: the decision to DROP the matching standing
   *  prompt notices is taken on the host, so a capability that silently does not exist inside the
   *  membrane leaves that session with neither the notice nor the mechanism. Absent/empty → no
   *  flags, keeping the output byte-identical to a pre-#2002 spawn. */
  agentSupportPaths?: string[];
  /** This session's Browser Attach config file (ADR 0001), bound RO at the same path. It lives
   *  under `~/.shepherd/browser-attach/`, which nothing else binds, so each membrane sees only
   *  its own session's token file. Absent → no flag (autonomous / Shared Browser off). */
  browserConfigFile?: string | null;
  /** api-key mode: present <claudeDir>/.credentials.json as GENUINELY ABSENT
   *  inside the sandbox (not an empty /dev/null overlay) by binding every child
   *  of claudeDir individually EXCEPT the credential file — matching the
   *  credential-less CLAUDE_CONFIG_DIR mirror (auth-config-dir.ts). Also skips
   *  the rw credentials bind. So no "Use custom API key?"/re-auth prompt fires. */
  maskCredentials?: boolean;
  /** Host dir to bind AS `<claudeDir>/projects` inside the sandbox. Default
   *  `<claudeDir>/projects` (source == dest — byte-identical). A plugin-redirected aux
   *  spawn (#1213) sets this to the ACTIVE projects dir so the reviewer transcript lands
   *  where Shepherd's usage/activity readback looks (config.claudeProjectsDir via
   *  jsonlPathFor) even though auth comes from the (pool) claudeDir. */
  projectsBindSource?: string;
  /** Host path of this spawn's private copy of the `.claude.json` Claude reads (see
   *  membrane-state.ts), bound RW in its place. Absent → the host file is bound READ-ONLY. */
  claudeJsonCopy?: string | null;
  /** Codex CLI support — set only for a `codex` inner argv (see membraneForArgv).
   *  Absent (claude spawns): flags stay byte-identical to the historical output. */
  codex?: CodexMembraneInputs;
  /** Reviewer-style aux spawn (critic, plan gate, maintain — audit N10): no `~/.gitconfig` or
   *  `~/.config/gh` bind (the server, not the role, talks to the forge) and the git common dir
   *  READ-ONLY. Absent → task-session flags, byte-identical. */
  reviewer?: boolean;
  /** This session's 0600 ingress spawn files (`--settings`, `--mcp-config`, key — see
   *  assistant-ingress.ts), bound RO at the same path. Not `-try`: the spawn just wrote them. */
  ingressFiles?: string[];
  /** This spawn's derived tools-only mise config (membrane-state.ts), bound RO at
   *  {@link MEMBRANE_MISE_CONFIG} and named by `MISE_SYSTEM_CONFIG_FILE`. The host
   *  `~/.config/mise` is never bound. Absent → no flags, byte-identical. */
  miseConfigFile?: string | null;
  /** This spawn's 0600 gh `hosts.yml` carrying a keyring-stored token (membrane-state.ts),
   *  bound RO over `~/.config/gh/hosts.yml`. Task sessions only. Absent → no flags. */
  ghHostsFile?: string | null;
}

// ── codex CLI membrane support ────────────────────────────────────────────────

/**
 * Resolved host paths that let a wrapped `codex exec` role start and authenticate
 * inside the membrane. Without them every sandboxed codex spawn (plan-gate reviewer,
 * PR critic, standalone critic, doc-agent) died silently: the claude-only membrane
 * bound neither the codex launcher chain (execvp ENOENT on the dangling
 * `~/.bun/bin/codex` symlink) nor `~/.codex` (`--tmpfs $HOME` hides auth.json → 401).
 */
export interface CodexMembraneInputs {
  /** dirname of the `codex` launcher as found on Shepherd's PATH (often a symlink
   *  dir, e.g. `~/.bun/bin`) — bound RO and appended to the sandbox PATH. */
  binDir: string;
  /** RO bind covering the launcher's REAL file and its runtime siblings: the nearest
   *  `node_modules` ancestor of the realpath'd launcher (the platform package holding
   *  the native binary is a SIBLING package, so the package dir alone is not enough),
   *  or the realpath's dirname when no node_modules ancestor exists (standalone bin). */
  pkgRoot: string;
  /** CODEX_HOME (auth.json, config.toml, sessions/, sqlite state) — bound RW: token
   *  refresh, rollout writes and sqlite WAL all need a writable directory. Tool-level
   *  writes stay confined by codex's own `--sandbox workspace-write`. */
  codexHome: string;
  /** Shepherd's `--output-schema` dir (CODEX_ROLE_SCHEMA_DIR) — bound RO. It sits in the Shepherd
   *  checkout under the tmpfs'd `$HOME`; unbound, every schema-constrained role (critic, plan
   *  review, …) died at startup with "Failed to read output schema file" (#2595). */
  schemaDir: string;
}

/** Injectable host probes for codex membrane resolution (tests never touch the host). */
export interface CodexProbeDeps {
  /** PATH lookup; default Bun.which. */
  which?: (cmd: string) => string | null;
  /** realpath; default safeRealpath. */
  realpath?: (p: string) => string;
  /** Host env (CODEX_HOME override); default process.env. */
  env?: Record<string, string | undefined>;
}

/** Nearest ancestor directory named `node_modules`, or null when none. */
function nodeModulesAncestor(p: string): string | null {
  for (let dir = dirname(p); ; dir = dirname(dir)) {
    if (basename(dir) === "node_modules") return dir;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * Resolve the codex membrane inputs for `home`, or null (with a warn — never a
 * silent drop) when `codex` is not on Shepherd's own PATH. On null the spawn fails
 * exactly as before, but traceably.
 */
export function resolveCodexMembrane(
  home: string,
  deps: CodexProbeDeps = {},
): CodexMembraneInputs | null {
  const which = deps.which ?? ((cmd: string) => Bun.which(cmd));
  const bin = which("codex");
  if (!bin) {
    console.warn(
      "[sandbox] codex spawn requested but `codex` is not on PATH — membrane gets no codex binds",
    );
    return null;
  }
  const real = (deps.realpath ?? safeRealpath)(bin);
  const env = deps.env ?? process.env;
  const codexHome = env.CODEX_HOME || `${home}/.codex`;
  return {
    binDir: dirname(bin),
    pkgRoot: nodeModulesAncestor(real) ?? dirname(real),
    codexHome,
    schemaDir: CODEX_ROLE_SCHEMA_DIR,
  };
}

/**
 * The membrane for an inner argv: a `codex` spawn gets the resolved codex inputs
 * folded in (unless the caller already did); anything else passes through untouched.
 * SINGLE source for the detection so wrapArgv and service.ts's egress branch (which
 * calls buildMembraneFlags directly) can never drift.
 */
export function membraneForArgv(
  innerArgv: string[],
  membrane: MembraneInputs,
  deps: CodexProbeDeps = {},
): MembraneInputs {
  if (innerArgv[0] !== "codex" || membrane.codex) return membrane;
  const codex = resolveCodexMembrane(membrane.home, deps);
  return codex ? { ...membrane, codex } : membrane;
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
 * Sub-paths of a manager root that the manager REWRITES on every invocation, and which therefore
 * cannot sit under the read-only bind above.
 *
 * `mise` is the live case (same host change behind #2052). A mise-managed `claude` is reached
 * through a launcher on PATH that re-runs `mise use`, and mise rebuilds `shims/` as part of that —
 * under the RO bind the rebuild hits EROFS and mise exits non-zero, so the agent process NEVER
 * STARTS. Nothing observes
 * that directly: the role's verdict file simply never appears, the caller waits out its whole
 * timeout (10 min for the plan gate), records a `no-verdict` error and re-spawns into the same
 * wall. Every membrane-wrapped role — plan gate, PR critic, doc agent, standalone critic — fails
 * this way at once.
 *
 * A tmpfs is the narrow fix: the rebuild succeeds against throwaway storage, the write never
 * reaches the host, and `installs/` stays read-only — so a sandboxed role still cannot plant a
 * binary that a later trusted session would run.
 *
 * NOT covered, deliberately: a manager asked for a version the host has not installed yet still
 * needs to download into the read-only `installs/`, and will still fail. Making that writable would
 * let an untrusted role pull and execute arbitrary tool versions, which is the opposite of what the
 * membrane is for. Installing toolchains stays a host-side, trusted-session concern.
 */
function managerScratch(home: string): Record<string, string[]> {
  return { [`${home}/.local/share/mise`]: ["shims"] };
}

/**
 * Where the derived mise config sits inside the membrane. `--tmpfs $HOME` hides the host's global
 * config, so a mise-launched `claude` (`mise x claude`) sees a toolset of just `claude` and strips
 * every other `installs/*` dir — the membrane's own node and bun included — from PATH. A system
 * config (`MISE_SYSTEM_CONFIG_FILE`) restores the toolset without touching `~/.config/mise`, which
 * `mise use -g` keeps writing into the throwaway home. Under `/tmp` because bwrap can create the
 * mountpoint on that tmpfs.
 */
export const MEMBRANE_MISE_CONFIG = "/tmp/.shepherd-mise/config.toml";

/** RO bind of the derived mise config; empty when absent. Must follow `--tmpfs /tmp`. */
function miseConfigFlags(file: string | null | undefined): string[] {
  return typeof file === "string" && file.length > 0
    ? ["--ro-bind", file, MEMBRANE_MISE_CONFIG]
    : [];
}

/**
 * Compute the RO toolchain binds for the node binary. Always binds the binary's
 * own directory; additionally binds any known manager root that is a PREFIX of
 * nodeBinReal OR exists on the host. De-dupes so the same path isn't bound twice
 * and a child of an already-bound root is skipped.
 *
 * Each bound root is immediately followed by a `--tmpfs` per {@link managerScratch} entry. Order is
 * load-bearing: bwrap applies operations in sequence, so the tmpfs must come AFTER the `--ro-bind`
 * it punches through, never before.
 */
function nodeToolchainFlags(inputs: MembraneInputs, exists: (p: string) => boolean): string[] {
  const binDir = dirname(inputs.nodeBinReal);
  const scratch = managerScratch(inputs.home);
  const added: string[] = [];
  const flags: string[] = [];
  const isUnder = (p: string, root: string) => p === root || p.startsWith(root + "/");
  const add = (p: string) => {
    if (added.some((a) => a === p || isUnder(p, a))) return; // already bound or under a bound root
    added.push(p);
    flags.push("--ro-bind-try", p, p);
    for (const sub of scratch[p] ?? []) flags.push("--tmpfs", `${p}/${sub}`);
  };

  // Manager roots first so a binDir under one of them is de-duped away.
  for (const root of managerRoots(inputs.home)) {
    if (isUnder(inputs.nodeBinReal, root) || exists(root)) add(root);
  }
  add(binDir);
  if (inputs.bunBinReal) add(dirname(inputs.bunBinReal));
  return flags;
}

/**
 * This session's Browser Attach config file, bound RO at the same path — this session's only, and
 * after `--tmpfs $HOME` so it is not masked. Not `-try`: the spawn just wrote it, and a missing
 * token file must fail loudly rather than silently. Empty when absent.
 */
function browserConfigFlags(file: string | null | undefined): string[] {
  return typeof file === "string" && file.length > 0 ? ["--ro-bind", file, file] : [];
}

/**
 * The tool-guard hook script + the agent-skills dir (issue #2002), bound RO at the same path so the
 * `--settings` hook command and the `--add-dir` flag resolve inside the sandbox. `-try` so a missing
 * path degrades to "capability absent" rather than crashing bwrap. Empty when the features are off,
 * keeping the flags byte-identical to a pre-#2002 spawn.
 */
function agentSupportFlags(paths: string[] | undefined): string[] {
  const f: string[] = [];
  for (const p of paths ?? []) {
    if (typeof p === "string" && p.length > 0) f.push("--ro-bind-try", p, p);
  }
  return f;
}

/**
 * Codex CLI flags — empty for a non-codex spawn, keeping claude flags byte-identical.
 * Launcher chain RO: binDir (the PATH lookup target, often a symlink dir) plus the
 * realpath'd package tree (the native platform binary is a SIBLING package under the
 * same node_modules, so binding the launcher's package alone would not start).
 * CODEX_HOME RW: auth.json token refresh, sessions/ rollouts and sqlite WAL files
 * all need a writable directory; tool-level writes remain confined by codex's own
 * `--sandbox workspace-write`. The `--output-schema` dir RO: codex reads it at startup.
 */
function codexCliFlags(codex: CodexMembraneInputs | undefined): string[] {
  if (!codex) return [];
  const f = ["--ro-bind-try", codex.binDir, codex.binDir];
  if (codex.pkgRoot !== codex.binDir) f.push("--ro-bind-try", codex.pkgRoot, codex.pkgRoot);
  f.push("--bind-try", codex.codexHome, codex.codexHome);
  f.push("--ro-bind-try", codex.schemaDir, codex.schemaDir);
  return f;
}

/** The sandbox PATH. The bun dir (#3351) follows node's; a codex spawn appends the launcher's
 *  bin dir so `codex` resolves by name. Each is skipped when it already is an entry. */
function sandboxPath(
  home: string,
  nodeBinDir: string,
  bunBinDir: string | null,
  codex?: CodexMembraneInputs,
): string {
  const entries = [`${home}/.local/bin`, nodeBinDir];
  if (bunBinDir && !entries.includes(bunBinDir)) entries.push(bunBinDir);
  entries.push("/usr/bin", "/bin");
  if (codex && !entries.includes(codex.binDir)) entries.push(codex.binDir);
  return entries.join(":");
}

/** `--setenv CODEX_HOME` for a codex spawn with a non-default home: --clearenv strips
 *  it, and codex must be pointed back at the dir the membrane bound (the default
 *  ~/.codex needs no env — codex derives it from HOME). Empty otherwise. */
function codexEnvFlags(home: string, codex?: CodexMembraneInputs): string[] {
  if (!codex || codex.codexHome === `${home}/.codex`) return [];
  return ["--setenv", "CODEX_HOME", codex.codexHome];
}

/**
 * api-key mode base binds for the claude config dir, presenting
 * `.credentials.json` as GENUINELY ABSENT (not an empty /dev/null overlay).
 *
 * bwrap cannot hide a single child of a whole-dir bind, so instead of binding
 * `claudeDir` wholesale we `--dir` the mount point (so it exists even when the
 * dir is empty) then bind every child RO individually EXCEPT the credential
 * file. The OAuth token simply does not exist inside the sandbox — exactly the
 * shape of the credential-less CLAUDE_CONFIG_DIR mirror (auth-config-dir.ts),
 * so no "Use custom API key?"/re-auth prompt can fire on empty/invalid creds.
 * Entries are sorted for deterministic, testable output.
 */
function maskedClaudeDirBinds(claudeDir: string, readdir: (p: string) => string[]): string[] {
  const flags = ["--dir", claudeDir];
  for (const entry of readdir(claudeDir)
    .filter((e) => e !== ".credentials.json")
    .sort()) {
    flags.push("--ro-bind-try", `${claudeDir}/${entry}`, `${claudeDir}/${entry}`);
  }
  return flags;
}

/** `<claudeDir>` children that get a per-membrane tmpfs instead of the shared host dir. */
export const EPHEMERAL_CLAUDE_DIRS = ["shell-snapshots", "todos", "statsig"] as const;

/**
 * The spawn's own transcript dir (`projects/<dashify(cwd)>`) RW over the RO projects bind, with
 * its `memory/` kept read-only (or a tmpfs when absent, so nothing written there reaches the
 * host). Only when the host dir exists: a missing source could not be mounted under the RO
 * projects bind; prepareMembraneClaudeState creates it for real spawns.
 */
function ownTranscriptFlags(
  projectsSrc: string,
  projectsDest: string,
  cwd: string,
  exists: (p: string) => boolean,
): string[] {
  const src = `${projectsSrc}/${dashify(cwd)}`;
  if (!exists(src)) return [];
  const dest = `${projectsDest}/${dashify(cwd)}`;
  const memory = exists(`${src}/memory`)
    ? ["--ro-bind", `${src}/memory`, `${dest}/memory`]
    : ["--tmpfs", `${dest}/memory`];
  return ["--bind", src, dest, ...memory];
}

/** The `.claude.json` Claude reads (`target`): the per-spawn copy RW, else the host file RO. */
function claudeJsonFlags(target: string, copy: string | null | undefined): string[] {
  return typeof copy === "string" && copy.length > 0
    ? ["--bind", copy, target]
    : ["--ro-bind-try", target, target];
}

/**
 * Audit F05 / run-2 R2-F01 + R2-F06: re-bind the git store's exec-capable state read-only AFTER
 * its rw bind (bwrap applies binds in order), so an agent can't plant config, a commondir
 * redirect, a hook, a submodule git dir or a launcher that unconfined host git / Shepherd later
 * runs, or attributes / legacy remote definitions (`info/`, `remotes/`, `branches/`) it reads.
 * Fail closed — never `-try`: a present path is `--ro-bind`; an absent dir becomes an empty RO
 * tmpfs, so the agent can't create it either (bwrap leaves an empty mount-point stub on the
 * host). `config`, `commondir` and `config.worktree` (the latter two made on the host by
 * {@link hostGitStore}) are required. With config RO, git's own config writes (`push -u`
 * upstream, `git config`) fail with EBUSY; branch/commit/push still succeed.
 */
function gitStoreReadOnlyFlags(
  gitDir: string,
  exists: (p: string) => boolean,
  adminDir: string | null,
): string[] {
  const p = (sub: string) => `${gitDir}/${sub}`;
  const dirs = ["hooks", "shepherd", "modules", "worktrees", "info", "remotes", "branches"];
  const dirFlags = dirs.flatMap((sub) =>
    exists(p(sub)) ? ["--ro-bind", p(sub), p(sub)] : ["--tmpfs", p(sub), "--remount-ro", p(sub)],
  );
  return [
    ...["--ro-bind", p("config"), p("config")],
    ...["--ro-bind", p("commondir"), p("commondir")],
    ...worktreeConfigFlags(gitDir),
    ...dirFlags,
    ...ownAdminDirFlags(adminDir),
  ];
}

/** `<dir>/config.worktree` RO — git reads it under `extensions.worktreeConfig`. */
function worktreeConfigFlags(dir: string): string[] {
  const target = `${dir}/config.worktree`;
  return ["--ro-bind", target, target];
}

/** Under the RO `worktrees/`, only the session's own admin dir (HEAD, index, logs) is RW again —
 *  minus its `commondir`, which host git in that worktree would follow, and its
 *  `config.worktree`. */
function ownAdminDirFlags(adminDir: string | null): string[] {
  if (adminDir === null) return [];
  const commondir = `${adminDir}/commondir`;
  return [
    ...["--bind", adminDir, adminDir, "--ro-bind", commondir, commondir],
    ...worktreeConfigFlags(adminDir),
  ];
}

/** Host prep + carve-outs for a store bound RW at `store`. The prep only runs for a store that is
 *  there (an absent one fails the RW bind anyway), so flag-shape tests stay pure. */
function writableStoreFlags(
  store: string,
  inputs: MembraneInputs,
  exists: (p: string) => boolean,
  gitStore: GitStoreDeps,
): string[] {
  if (exists(store)) {
    gitStore.pinCommondir(store);
    gitStore.ensureWorktreeConfig(store);
  }
  const adminDir =
    inputs.isolated && exists(`${store}/worktrees`)
      ? gitStore.adminDir(inputs.repoPath, inputs.worktreePath)
      : null;
  if (adminDir !== null) gitStore.ensureWorktreeConfig(adminDir);
  return ["--bind", store, store, ...gitStoreReadOnlyFlags(store, exists, adminDir)];
}

/** `~/.gitconfig` (commit identity) + `~/.config/gh` (the gh token) RO — task sessions only. A
 *  reviewer-style role never pushes or calls the forge (the server does), so it gets neither. */
function forgeIdentityFlags(
  home: string,
  reviewer: boolean | undefined,
  ghHostsFile: string | null | undefined,
): string[] {
  if (reviewer) return [];
  return [
    ...["--ro-bind-try", `${home}/.gitconfig`, `${home}/.gitconfig`],
    ...["--ro-bind-try", `${home}/.config/gh`, `${home}/.config/gh`],
    // A keyring-stored token never reaches the bound dir; this per-spawn copy carries it.
    ...(typeof ghHostsFile === "string" && ghHostsFile.length > 0
      ? ["--ro-bind", ghHostsFile, `${home}/.config/gh/hosts.yml`]
      : []),
  ];
}

/** Isolated: the worktree (rw) + the ABSOLUTE shared object store (rw; RO for a reviewer, which
 *  needs no carve-outs — and can't take them: no mount point can be made under a RO bind). Else
 *  the whole repo, plus — only when its `.git` is a real store dir (a gitfile `.git` binds no
 *  store) — the same store self-bind + carve-outs. */
function worktreeFlags(
  inputs: MembraneInputs,
  exists: (p: string) => boolean,
  gitStore: GitStoreDeps,
): string[] {
  if (!inputs.isolated) {
    const gitDir = `${inputs.repoPath}/.git`;
    return [
      ...["--bind", inputs.repoPath, inputs.repoPath],
      // Self-bind pins `.git` as a mount point (no rename/replace from inside), as in isolated.
      ...(exists(`${gitDir}/config`) ? writableStoreFlags(gitDir, inputs, exists, gitStore) : []),
    ];
  }
  const store = inputs.gitCommonDir;
  return [
    ...["--bind", inputs.worktreePath, inputs.worktreePath],
    ...(inputs.reviewer
      ? ["--ro-bind", store, store]
      : writableStoreFlags(store, inputs, exists, gitStore)),
  ];
}

/**
 * The frozen, host-derived membrane flag list (validated against real claude
 * 2.1.173 on the reference host). Returns the bwrap argv PREFIX flags only —
 * `wrapArgv` appends `-- <innerArgv>`.
 *
 * Every host-variable path uses `*-bind-try` so an absent source is SKIPPED, not
 * a hard fail. Only paths guaranteed to exist on any Linux host (/usr, /etc) use
 * a plain `--ro-bind` — plus the git-store carve-outs, which must fail closed
 * ({@link gitStoreReadOnlyFlags}).
 */
export function buildMembraneFlags(inputs: MembraneInputs, deps: PathProbeDeps = {}): string[] {
  const exists = deps.exists ?? existsSync;
  const readdir = deps.readdir ?? safeReaddir;
  const home = inputs.home;
  const claudeDir = inputs.claudeDir;
  const term = inputs.term ?? "xterm-256color";
  const projectsSrc = inputs.projectsBindSource ?? `${claudeDir}/projects`;

  // Claude config dir base bind(s). Two shapes:
  //  - subscription/default: the whole dir RO in one bind — byte-for-byte unchanged.
  //  - api-key (maskCredentials): per-child RO binds EXCEPT `.credentials.json`, so
  //    the OAuth token is GENUINELY ABSENT inside the sandbox (matching the
  //    credential-less CLAUDE_CONFIG_DIR mirror in auth-config-dir.ts) rather than
  //    an empty overlay — an empty/invalid creds file could trip a re-auth prompt.
  const claudeDirBaseBinds: string[] = inputs.maskCredentials
    ? maskedClaudeDirBinds(claudeDir, readdir)
    : ["--ro-bind", claudeDir, claudeDir];

  // Subscription/default: rw `--bind-try` so OAuth token refresh writes back.
  // api-key (maskCredentials): EMPTY — the credential is absent (see above), there
  // is no `.credentials.json` bind of any kind.
  const credentialFlags: string[] = inputs.maskCredentials
    ? []
    : ["--bind-try", `${claudeDir}/.credentials.json`, `${claudeDir}/.credentials.json`];

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
    // Subscription: whole-dir RO. api-key: per-child RO minus `.credentials.json`.
    ...claudeDirBaseBinds,
    // projects/: RO so a hijacked agent cannot rewrite other sessions' transcripts or any
    // project's memory (audit F06). Only this spawn's own transcript dir is re-bound RW below.
    // The SOURCE defaults to `<claudeDir>/projects` but a plugin-redirected aux spawn (#1213)
    // overrides it with the ACTIVE projects dir so the transcript lands where Shepherd's
    // usage/activity readback looks even when claudeDir is a (pool) config dir.
    "--ro-bind-try",
    projectsSrc,
    `${claudeDir}/projects`,
    ...ownTranscriptFlags(projectsSrc, `${claudeDir}/projects`, inputs.worktreePath, exists),
    // Shared state other (unconfined) Claude sessions execute or consume — shell-snapshots are
    // SOURCED before every Bash command — gets per-membrane throwaway storage instead of the
    // host dirs (audit F06). Guarded: bwrap cannot mkdir a mountpoint under the RO claudeDir
    // bind; prepareMembraneClaudeState creates them host-side for real spawns.
    ...EPHEMERAL_CLAUDE_DIRS.filter((d) => exists(`${claudeDir}/${d}`)).flatMap((d) => [
      "--tmpfs",
      `${claudeDir}/${d}`,
    ]),
    // session-env: claude 2.1.181+ mkdirs `<config-dir>/session-env/<id>` before EVERY
    // Bash command. A tmpfs (not a host bind) makes it writable + ephemeral per-session
    // scratch — no host pollution. MUST sit AFTER claudeDirBaseBinds so it overrides both
    // the subscription whole-dir `--ro-bind` and the api-key maskCredentials per-child
    // `--ro-bind-try` of session-env (else the mkdir fails EROFS and Bash dies).
    "--tmpfs",
    `${claudeDir}/session-env`,
    // OAuth credential: rw bind (subscription) or nothing (api-key mask: absent).
    ...credentialFlags,
    // .claude.json: a per-spawn COPY rw (trust/onboarding writes land there, else
    // non-interactive auto hangs on onboarding), never the host file — it holds user/project
    // `mcpServers` that later unconfined sessions launch (audit F04). No copy → RO host file.
    ...claudeJsonFlags(claudeConfigPath(home, claudeDir), inputs.claudeJsonCopy),
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
  f.push(...miseConfigFlags(inputs.miseConfigFile));

  // ── codex CLI (codex spawns only — claude flags stay byte-identical) ─────
  // MUST sit after the `--tmpfs home` above so the RW CODEX_HOME bind punches
  // through the tmpfs.
  f.push(...codexCliFlags(inputs.codex));

  // ── commit identity + gh token (task sessions only: a reviewer never pushes) ──
  f.push(...forgeIdentityFlags(home, inputs.reviewer, inputs.ghHostsFile));

  // ── api-key helper (api-key mode only) ────────────────────────────────────
  // Bind the apiKeyHelper script RO at the SAME path so the `apiKeyHelper` entry
  // in --settings resolves inside the sandbox. Omitted (guarded) in subscription
  // mode so flags stay byte-identical.
  if (typeof inputs.apiKeyHelperPath === "string" && inputs.apiKeyHelperPath.length > 0) {
    f.push("--ro-bind-try", inputs.apiKeyHelperPath, inputs.apiKeyHelperPath);
  }

  // ── Shepherd-injected agent capabilities (issue #2002) ───────────────────
  f.push(...agentSupportFlags(inputs.agentSupportPaths));

  // ── Browser Attach config (ADR 0001) ─────────────────────────────────────
  f.push(...browserConfigFlags(inputs.browserConfigFile));

  // ── agent-ingress spawn files (issue #3337) ──────────────────────────────
  f.push(...(inputs.ingressFiles ?? []).flatMap((p) => ["--ro-bind", p, p]));

  // ── worktree / git store ─────────────────────────────────────────────────
  f.push(...worktreeFlags(inputs, exists, deps.gitStore ?? hostGitStore));

  // ── env + process hardening ──────────────────────────────────────────────
  // Clear ALL inherited env first, then re-set only what a compliant session needs.
  // This is what keeps env-resident secrets (GH_TOKEN, SHEPHERD_TOKEN, ANTHROPIC_*,
  // AWS_*, …) out of a hijacked agent — they would otherwise be inherited verbatim.
  const nodeBinDir = dirname(inputs.nodeBinReal);
  f.push("--clearenv");
  f.push("--setenv", "HOME", home);
  const bunBinDir = inputs.bunBinReal ? dirname(inputs.bunBinReal) : null;
  f.push("--setenv", "PATH", sandboxPath(home, nodeBinDir, bunBinDir, inputs.codex));
  f.push("--setenv", "TERM", term);
  // --clearenv strips CLAUDE_CONFIG_DIR; re-set it when the bound config dir is NOT the
  // default ~/.claude, else claude would fall back to an empty ~/.claude tmpfs (the custom
  // dir IS bound above) and lose auth/onboarding state.
  if (claudeDir !== `${home}/.claude`) f.push("--setenv", "CLAUDE_CONFIG_DIR", claudeDir);
  f.push(...codexEnvFlags(home, inputs.codex));
  if (miseConfigFlags(inputs.miseConfigFile).length > 0)
    f.push("--setenv", "MISE_SYSTEM_CONFIG_FILE", MEMBRANE_MISE_CONFIG);
  for (const [k, v] of Object.entries(inputs.extraEnv ?? {})
    .filter(([k]) => !(AGENT_SHELL_MARKERS as readonly string[]).includes(k))
    .sort(([a], [b]) => a.localeCompare(b))) {
    f.push("--setenv", k, v);
  }
  f.push("--setenv", "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE", "1");
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
  deps: PathProbeDeps & CodexProbeDeps = {},
): string[] {
  if (opts.profile === "trusted" || opts.backend === null) return innerArgv;
  const membrane = membraneForArgv(innerArgv, opts.membrane, deps);
  return ["bwrap", ...buildMembraneFlags(membrane, deps), "--", ...innerArgv];
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
    return "Autonomous spawn requires the autonomous or trusted profile (standard is interactive-only).";
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

/**
 * Returns a hold reason when an auto=true spawn of `provider` must be refused under `profile` (the
 * repo's configured profile, NOT the spawn's effective one), else null. A Codex task session always
 * runs unconfined (`--dangerously-bypass-approvals-and-sandbox`, profile forced to trusted), so it
 * may run unattended only where the operator chose `trusted` anyway — never silently in a repo set
 * to a confining profile (F12).
 */
export function codexAutoHoldReason(
  provider: string | null | undefined,
  profile: SandboxProfile,
): string | null {
  if (provider !== "codex" || profile === "trusted") return null;
  return `Autonomous Codex spawn refused: Codex runs unconfined and this repo's sandbox profile is ${profile}.`;
}

/** Thrown when an auto spawn is refused (auto hold reason present). */
export class SandboxAutoRefused extends Error {
  readonly holdReason: string;
  constructor(holdReason: string, cause?: unknown) {
    super(holdReason);
    this.name = "SandboxAutoRefused";
    this.holdReason = holdReason;
    if (cause !== undefined) this.cause = cause;
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

/**
 * Whether this spawn will actually run egress-confined: an autonomous profile
 * (egressApplies) WITH both the FS sandbox backend AND the egress backend present.
 * The single source of truth for "egress wraps this spawn" — shared by prepareSpawn
 * (the wrap decision) and the agent base-URL decision (which control-plane address to
 * bake) so the two can never drift.
 */
export function willEgressConfine(
  profile: SandboxProfile,
  backend: SandboxBackend,
  egressBackend: EgressBackend,
): boolean {
  return egressApplies(profile) && backend !== null && egressBackend != null;
}
