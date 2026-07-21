import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cpus } from "node:os";
import { promisify } from "node:util";
import {
  BUN_MIN_VERSION,
  DIAGNOSTICS_PROBE_TIMEOUT_MS,
  DIAGNOSTICS_TTL_MS,
  GH_PROBE_ATTEMPTS,
  GH_PROBE_RETRY_DELAY_MS,
  GH_PROBE_TIMEOUT_MS,
  HERDR_MIN_VERSION,
  HOST_PSI_IO_AVG10,
  HOST_PSI_MEMORY_AVG10,
  HOST_PSI_MEMORY_AVG10_CORROBORATED,
  HOST_SWAP_SATURATION_RATIO,
  NODE_MIN_VERSION,
  REMEDIATION_TIMEOUT_MS,
  config,
  findServedPort,
} from "./config";
import { parseGitVersion, gitVersionAtLeast, MIN_GIT_MAJOR, MIN_GIT_MINOR } from "./forge/local";
import { compareSemver } from "./herdr-update";
import { autoFixCommandFor } from "./remediations";
import { resolveNodeHost } from "./tailscale";
import { readCodexAuthMode } from "./codex-auth";
import { claudeConfigPath, readRepoRootTrusted, trustRepoRoot } from "./claude-trust";
import { isApiKeyMode } from "./spawn-auth";
import {
  resolveRoleEnvironment,
  CHATGPT_INCOMPATIBLE_CODEX_MODELS,
  type CodexAuthMode,
} from "./default-model";
import { matchAgents, type IHerdrDriver } from "./herdr";
import { isShepherdHelperLabel } from "./tab-reaper";
import {
  TMP_INODE_ERROR_PCT,
  readTmpInodeUsePct,
  sweepClaudeTmp,
  tmpInodeWarnPct,
} from "./tmp-sweep";
import { SHELLS } from "./json-tolerant";
import type { SessionStore } from "./store";
import type { DiagnosticCheck, DiagnosticsSnapshot, DiagnosticState } from "./types";

const execFileAsync = promisify(execFile);

/** Reused from herdr-update.ts's parsing discipline — a (major.minor.patch)
 *  capture. Kept local so the regex's lastIndex state is never shared. */
const SEMVER_RE = /(\d+\.\d+\.\d+)/;

/** Resolve after `ms` — used to space out the gh probe's bounded retries. */
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** True when a rejected probe was KILLED (timeout → SIGTERM) rather than having exited
 *  with its own status. execFile's timeout path sets `killed:true` + a `signal`; a normal
 *  non-zero exit sets neither. This is how `ghProbe` tells a transient stall (retry, then
 *  "couldn't verify") apart from a real auth verdict (error) — no stdout/stderr parsing. */
function isTransientProbeFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
  return e.killed === true || (typeof e.signal === "string" && e.signal.length > 0);
}

/** A spawn that failed because the binary isn't on PATH. */
function isEnoent(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** Map a non-ok gh outcome: the given (state, hintKey) when a forge-mode repo needs gh,
 *  else a soft `not_required` warning (gh is optional when all repos are lightweight). */
function ghFailure(forge: boolean, state: DiagnosticState, hintKey: string): DiagnosticCheck {
  return forge
    ? { id: "gh", state, hintKey }
    : { id: "gh", state: "warning", hintKey: "diagnostics_hint_gh_not_required" };
}

/** Log a timed-out gh probe using ONLY its disposition — never stderr/stdout/message,
 *  which can carry the logged-in account identity. */
function logGhUnverified(err: unknown, attempts: number): void {
  const e = (err ?? {}) as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
  console.warn(
    `[diagnostics] gh auth status could not be verified after ${attempts} attempts` +
      ` (timed out; code=${String(e.code)} killed=${String(e.killed)} signal=${String(e.signal)})`,
  );
}

/**
 * Injectable child-process runners. Each defaults to an async `execFile` with a
 * per-probe timeout (`DIAGNOSTICS_PROBE_TIMEOUT_MS`) — **never** `execFileSync`,
 * so a hung binary can't block Bun's single thread. Tests override these so no
 * real binaries are needed.
 */
export interface DiagnosticsDeps {
  /** Run `<bin> <args...>` and return stdout. Used for every `--version` probe
   *  plus the `which`/presence checks. Reject (incl. timeout) ⇒ binary absent. */
  runVersion?: (bin: string, args: string[]) => Promise<string>;
  /** Probe herdr **server liveness** (not just binary presence): run `herdr agent
   *  list`, resolving on a zero exit (daemon reachable), rejecting on
   *  connection-refused / timeout (daemon offline). Exit code only — the agent
   *  listing is discarded (routed to /dev/null, never buffered), so nothing but a
   *  state crosses into the snapshot. This is the same reachability signal
   *  `herdr-update` relies on. Default `spawn(config.herdrBin, ["agent","list"], {
   *  stdio:"ignore" })` with the shared probe timeout. Injected in tests (resolve =
   *  live, reject = offline). */
  runHerdrLiveness?: () => Promise<void>;
  /** Run `gh auth status`; resolves on a zero exit, rejects on non-zero / timeout.
   *  Its stdout is intentionally discarded (it carries account identity). On rejection
   *  the error's `code` / `killed` / `signal` classify the failure (see `ghProbe`):
   *  a killed/signalled reject = a transient timeout, a plain non-zero exit = a real
   *  auth verdict. */
  runGhAuth?: () => Promise<void>;
  /** Attempts for the gh probe's bounded retry loop (default `GH_PROBE_ATTEMPTS`).
   *  Injected so tests exercise the retry/exhaustion paths deterministically. */
  ghProbeAttempts?: number;
  /** Delay between gh probe retries in ms (default `GH_PROBE_RETRY_DELAY_MS`). Tests
   *  pass 0 so a retried-failure case adds no real wall-time. */
  ghProbeRetryDelayMs?: number;
  /** This node's tailnet hostname, or null when tailscale is absent / not logged
   *  in. Defaults to the shared `resolveNodeHost`. */
  resolveHost?: () => Promise<string | null>;
  /** Raw `tailscale serve status --json` output, parsed into a served-port via
   *  `findServedPort`. Both a direct `tailscale serve` mapping and a Tailscale
   *  Service mapping are detected. Reject ⇒ treated as "not serving". */
  runServeStatus?: () => Promise<string>;
  /** Run a verbatim remediation command (a shell pipeline like `curl … | bash`).
   *  Resolves on exit 0; rejects on non-zero exit or timeout. Default spawns a
   *  detached process group and SIGKILLs the whole group on timeout. Injected in tests. */
  runRemediation?: (cmd: string) => Promise<void>;
  /** Returns true when at least one configured repo has repoMode "forge".
   *  Default `() => true` preserves today's behavior (gh failure = error). */
  anyForgeRepo?: () => boolean;
  /** Returns true when at least one configured repo has repoMode "lightweight".
   *  Default `() => false` (no extra git capability warning unless opted in). */
  anyLightweightRepo?: () => boolean;
  /** Detect the Codex CLI auth mode (chatgpt / apikey / unknown). Default reads
   *  `~/.codex/auth.json`. Injected in tests to exercise the codex_model_auth check. */
  readCodexAuthMode?: () => CodexAuthMode;
  /** Additional live Codex models configured outside role/global settings (repo defaults, epics). */
  configuredCodexModels?: () => readonly (string | null)[];
  /** True iff Claude Code trusts `config.repoRoot` (`hasTrustDialogAccepted`). Default reads the
   *  config-dir-aware `.claude.json`. Injected in tests to drive the `claude_trust` check. */
  readClaudeTrusted?: () => Promise<boolean>;
  /** Seed `config.repoRoot`'s trust flag — the `claude_trust` code fix. Default writes the same
   *  `.claude.json`. Injected in tests to spy the one-click fix without touching a real config. */
  trustClaude?: () => Promise<void>;
  /** True when the operator selected api-key auth mode. Module-level `isApiKeyMode` wrapped as a
   *  dep so the subscription-only `claude_trust` gate is deterministic in tests. */
  isApiKeyAuth?: () => boolean;
  /** Gather non-secret host-resource facts for the `host_capacity` check (#1732): the cgroup
   *  unit + its systemd limits, swap totals, and memory/io PSI. Default reads `/proc` +
   *  `systemctl show`; injected in tests so no real host state is touched. Reject ⇒ the probe
   *  falls back to `optional`/uninspectable (its `onTimeout`). */
  readHostResources?: () => Promise<HostCapacityFacts>;
  /** Reconcile active sessions vs the herdr fleet for the `herdr_health` check (#1835): count
   *  unclaimed, non-helper panes by foreground-process liveness. NO in-constructor functional
   *  default — it needs the store + herdr driver, which the service does not hold; the ctor default
   *  is a fail-safe reject so an unwired service resolves to `optional`/uninspectable rather than a
   *  false `ok`. Wired in `index.ts` via `defaultReadHerdrFleet`; injected in tests. */
  readHerdrFleet?: () => Promise<HerdrFleetFacts>;
  /** Read temp-filesystem inode facts for the `tmp_inodes` check (#1862). Default statfs's
   *  `tmpdir()` and pairs the result with the live bands; injected in tests so band boundaries are
   *  asserted without touching a real filesystem. Reject ⇒ the probe falls back to
   *  `optional`/uninspectable (its `onTimeout`). */
  readTmpInodes?: () => Promise<TmpInodeFacts>;
  /** Run the `tmp_inodes` one-click forced sweep (#1862). Default is functional
   *  (`sweepClaudeTmp({ thresholdPct: 0 })`), so no `index.ts` wiring is needed; injected in tests
   *  to spy the fix without sweeping. */
  runTmpSweep?: () => Promise<void>;
  /** Apply the `host_capacity` one-click fix (#1839): `systemctl --user set-property <unit>
   *  MemoryHigh=… CPUQuota=…` on each unbounded unit (live + persistent, no restart). Default runs
   *  the real command; injected in tests to spy the fix without touching a real unit. */
  applyHostLimits?: (
    units: string[],
    limits: { memoryHigh: string; cpuQuota: string },
  ) => Promise<void>;
}

/** A single probe: an async fn returning ONLY `{ id, state, hintKey }`. */
type Probe = () => Promise<DiagnosticCheck>;

const STATE_RANK: Record<DiagnosticState, number> = { ok: 0, optional: 0, warning: 1, error: 2 };

/** worst-of: error > warning > ok/optional. Empty ⇒ ok. */
function worstOf(checks: DiagnosticCheck[]): DiagnosticState {
  let worst: DiagnosticState = "ok";
  for (const c of checks) {
    if (STATE_RANK[c.state] > STATE_RANK[worst]) worst = c.state;
  }
  return worst;
}

/** Error checks that are steady-state rather than transient, so they must NOT accelerate the
 *  background re-check. `host_capacity` pressure can persist for hours; fast-polling the full
 *  probe fan-out (`diagnosticsTick` → `check()`) every `recheckMs` would pile ~10 fork/execs a
 *  minute onto a host already under memory/IO pressure — the manual Diagnose "Re-run" is the
 *  on-demand live path instead.
 *
 *  `tmp_inodes` (#1862) qualifies twice over. Its error is PERMANENT, not transient: the one-click
 *  fix sweeps only the caches this release knows how to drop, and the two largest consumers (a
 *  forked pnpm store, an abandoned tmp worktree) are not reclaimed yet — so the row commonly stays
 *  in error and would fast-poll forever. Worse, the amplification is self-inflicted: process
 *  spawning is exactly what starts failing once a tmpfs inode table is exhausted, so answering that
 *  condition with ~10 extra fork/execs a minute attacks the very resource the row is reporting. */
const STEADY_STATE_ERROR_CHECK_IDS = new Set<string>(["host_capacity", "tmp_inodes"]);

/**
 * Adaptive delay until the next background diagnostics re-check, chosen from the checks just
 * produced. A NON-steady-state `error` accelerates to `recheckMs`: a hard error (canonically
 * herdr `offline`) is expected to be transient/recoverable, and the client only learns it
 * cleared from the next `diagnostics:status` push — so re-checking every `recheckMs` while it
 * persists lets a healthy-again host self-correct within ~one recheck instead of staying pinned
 * until the next `intervalMs`. `warning` deliberately stays on `intervalMs` (steady-state by
 * design: advisory version floors, gh-not-required on lightweight hosts), and a
 * `STEADY_STATE_ERROR_CHECK_IDS` error (host_capacity pressure) is likewise exempt — accelerating
 * on either would fast-poll forever with no path back to the steady cadence.
 */
export function nextDiagnosticsDelay(
  checks: readonly DiagnosticCheck[],
  intervalMs: number,
  recheckMs: number,
): number {
  const accelerate = checks.some(
    (c) => c.state === "error" && !STEADY_STATE_ERROR_CHECK_IDS.has(c.id),
  );
  return accelerate ? recheckMs : intervalMs;
}

/** Cap on drained child output: just enough to keep a noisy `curl | bash` install
 *  from blocking on a full pipe, then dropped. NEVER surfaced to the client. */
const REMEDIATION_DRAIN_CAP = 1 << 20; // 1 MiB

/** Default `runRemediation`: spawn the verbatim command in its OWN process group
 *  (`detached`), drain stdout/stderr into a bounded sink (so a noisy install can't
 *  ENOBUFS or block on a full pipe), and SIGKILL the whole group on timeout. Resolves
 *  on exit 0, rejects otherwise — the rejection message is generic (no captured
 *  output / paths / identity ever reaches the caller). `timeoutMs` is injectable so
 *  tests can exercise the timeout/group-kill path without waiting the real budget. */
export function defaultRunRemediation(
  cmd: string,
  timeoutMs: number = REMEDIATION_TIMEOUT_MS,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("sh", ["-c", cmd], { detached: true });
    let drained = 0;
    const drain = (chunk: Buffer) => {
      if (drained < REMEDIATION_DRAIN_CAP) drained += chunk.length; // count then drop
    };
    child.stdout?.on("data", drain);
    child.stderr?.on("data", drain);
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      try {
        process.kill(-child.pid!, "SIGKILL"); // negative pid ⇒ kill the whole group
      } catch {
        /* group already gone */
      }
      reject(new Error("remediation timed out"));
    }, timeoutMs);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`remediation exited ${code}`));
    });
  });
}

/** Default `runHerdrLiveness`: spawn `herdr agent list` with stdout/stderr routed to
 *  /dev/null (`stdio: "ignore"`) — the exit code is the only signal, so a large agent
 *  listing on a busy server is never buffered and can never exceed a buffer cap and
 *  falsely read as offline (unlike `execFile`, whose 1 MiB `maxBuffer` would reject).
 *  Resolves on exit 0 (daemon reachable); rejects on non-zero exit, spawn error
 *  (ENOENT / ECONNREFUSED), or timeout (daemon offline). */
function defaultHerdrLiveness(bin: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, ["agent", "list"], { stdio: "ignore" });
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("herdr liveness timed out"));
    }, timeoutMs);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`herdr agent list exited ${String(code)}`));
    });
  });
}

/** The hintKey the `claude_trust` check emits when untrusted. Shared by the check emission and
 *  the `fix()` code-fix dispatch guard so a rename can't silently break dispatch (they must agree). */
const CLAUDE_TRUST_UNTRUSTED_HINT = "diagnostics_hint_claude_trust_untrusted";

/** Resolve the claude folder-trust deps for the `claude_trust` check + code fix (#1683),
 *  applying test overrides. Kept out of the constructor so its config-dir resolution and
 *  fallbacks don't inflate the constructor's complexity. Defaults target the SAME
 *  config-dir-aware `.claude.json` Claude reads, scoped to `config.repoRoot` (the /usage
 *  probe's cwd) — see claude-trust.ts / usage-probe.ts. */
function resolveClaudeTrustDeps(deps: DiagnosticsDeps): {
  readClaudeTrusted: () => Promise<boolean>;
  trustClaude: () => Promise<void>;
  isApiKeyAuth: () => boolean;
} {
  const cfg = claudeConfigPath(process.env.HOME ?? "", config.claudeDir);
  return {
    readClaudeTrusted: deps.readClaudeTrusted ?? (() => readRepoRootTrusted(cfg, config.repoRoot)),
    trustClaude: deps.trustClaude ?? (() => trustRepoRoot(cfg, config.repoRoot)),
    isApiKeyAuth: deps.isApiKeyAuth ?? isApiKeyMode,
  };
}

// ── host_capacity check (#1732) ──────────────────────────────────────────────
// Warns when a systemd-managed Shepherd host has no resource guardrails, or errors
// when the host is under dangerous live memory/IO pressure. Every field below drives
// a `classifyHostCapacity` decision — nothing is wired speculatively (systemd-oomd and
// CPU PSI were deliberately left out of v1; see the plan / issue). The struct carries
// only parsed booleans/numbers, never raw command output, so payload purity is trivial.

/** Non-secret host-resource facts, produced by `readHostResources`, classified by
 *  `classifyHostCapacity`. */
export interface HostCapacityFacts {
  /** The `*.service` this process runs under (from `/proc/self/cgroup`), else null when
   *  not run as a managed service (a `bun run` in a login `*.scope`, or non-systemd). */
  unit: string | null;
  /** Whether the process runs under a systemd `user@…` manager (⇒ `systemctl --user`, and the
   *  server can `set-property` without root). Gates whether the one-click fix (#1839) is offered. */
  userScope: boolean;
  /** Whether `unit` OR its custom slice has a meaningful limit (MemoryHigh/MemoryMax/CPUQuota).
   *  null when `unit` is null OR the unit was found but its limits couldn't be read — either
   *  way the guardrail verdict is unknown and `classify` falls through to uninspectable. */
  limited: boolean | null;
  /** Whether `herdr.service` (the sibling user unit running agent sessions) OR its custom slice has a
   *  meaningful limit. `null` when it is not a *loaded user* unit (absent / masked / system-scoped) or
   *  is unreadable — either way it is excluded from the verdict and the fix. Read only on the
   *  `userScope` path (the only scope the `--user` fix can act on). */
  herdrLimited: boolean | null;
  /** Swap totals in bytes, or null when `/proc/meminfo` is unreadable. `total: 0` ⇒ no swap. */
  swap: { total: number; used: number } | null;
  /** PSI avg10 (% of the last 10s tasks were stalled) for memory/io; a field is null when that
   *  `/proc/pressure/<res>` is absent, and the whole struct is null when neither exists. */
  pressure: { memory: number | null; io: number | null } | null;
  /** Total RAM in bytes (`/proc/meminfo` MemTotal), or null when unreadable. Drives `proposeHostLimits`. */
  memTotal: number | null;
  /** Host logical core count (`os.cpus().length`) — the box's total cores for CPUQuota headroom
   *  sizing, deliberately NOT the affinity-masked `os.availableParallelism()`. */
  cpuCount: number;
}

/** Parse `/proc/self/cgroup`. cgroup v2 emits a single `0::<path>` line; we trust only that
 *  (v1's `N:ctrl:<path>` lines are ignored). Returns the leaf unit when it is a `*.service`
 *  (⇒ systemd-managed) and whether it lives under a `user@…` manager (⇒ `systemctl --user`). */
export function parseCgroupUnit(cgroup: string): { unit: string | null; userScope: boolean } {
  const line = cgroup.split("\n").find((l) => l.startsWith("0::"));
  if (!line) return { unit: null, userScope: false };
  const path = line.slice(3);
  const userScope = path.includes("/user@");
  const leaf = path.split("/").filter(Boolean).pop() ?? "";
  return { unit: leaf.endsWith(".service") ? leaf : null, userScope };
}

// ── host_capacity one-click fix (#1839) ──────────────────────────────────────
// The fix dispatches on HOST_CAPACITY_FIX_ACTION (a `fixActionKey`), NOT a hintKey, because both the
// Shepherd-unbounded and the herdr-gap warnings can carry it — hintKey alone can't discriminate.
// HERDR_UNIT is the sibling user unit that runs agent sessions (deploy/herdr.service). MIN_TUNABLE
// guards auto-tuning implausibly small hosts (the boundary yields MemoryHigh=4G, still conservative).
const HOST_CAPACITY_UNBOUNDED_HINT = "diagnostics_hint_host_capacity_unbounded";
const HOST_CAPACITY_HERDR_UNBOUNDED_HINT = "diagnostics_hint_host_capacity_herdr_unbounded";
const HOST_CAPACITY_FIX_ACTION = "diagnostics_fix_action_host_capacity";
const HERDR_UNIT = "herdr.service";
const GIB = 1024 ** 3;
const MIN_TUNABLE_MEMTOTAL = 6 * GIB;

/** Interpret a `systemctl --user show herdr.service` prop map into herdr's unit-level guardrail state.
 *  `systemctl show` EXITS 0 for an absent / non-user unit with `LoadState=not-found` (+
 *  `MemoryHigh=infinity`), so a bare `hasMeaningfulLimit` would read a spurious `false` (positively
 *  unbounded). Any non-`loaded` LoadState ⇒ `null` (unknown → excluded from verdict + fix); a loaded
 *  unit ⇒ its unit-level verdict (the caller folds in a custom slice, as for Shepherd's unit). */
export function herdrLimitFromProps(props: Record<string, string>): boolean | null {
  if (props.LoadState !== "loaded") return null;
  return hasMeaningfulLimit(props);
}

/** Conservative host-derived guardrail values for the one-click fix (#1839). `MemoryHigh` (soft cap,
 *  reclaim/throttle, never OOM-kills) leaves `clamp(15%, 2GiB, 8GiB)` headroom; `CPUQuota` leaves
 *  `min(1 core, 15% of cores)` for the OS — so a 2-core host keeps an 85% ceiling (`170%`), not a
 *  halved `100%`, while large hosts reserve just one core. Whole-GiB / integer-percent strings so
 *  systemd parses them unambiguously. */
export function proposeHostLimits(
  memTotal: number,
  cpuCount: number,
): { memoryHigh: string; cpuQuota: string } {
  const reserve = Math.min(Math.max(0.15 * memTotal, 2 * GIB), 8 * GIB);
  const memoryHigh = `${Math.floor((memTotal - reserve) / GIB)}G`;
  const headroomPct = Math.min(100, Math.round(15 * cpuCount));
  const cpuQuota = `${100 * cpuCount - headroomPct}%`;
  return { memoryHigh, cpuQuota };
}

/** Parse `systemctl show` KEY=VALUE lines into a map. */
export function parseSystemctlShow(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const eq = raw.indexOf("=");
    if (eq <= 0) continue;
    out[raw.slice(0, eq)] = raw.slice(eq + 1).trim();
  }
  return out;
}

/** True when the unit sets at least one meaningful resource guardrail. systemd shows `infinity`
 *  for an unset MemoryHigh / MemoryMax / CPUQuota; `CPUQuotaPerSecUSec` is the real show-property
 *  for `CPUQuota`. `TasksMax` is intentionally NOT counted — systemd assigns a large default, so
 *  its presence is no signal of an intentional limit. */
export function hasMeaningfulLimit(props: Record<string, string>): boolean {
  const set = (v: string | undefined): boolean => v !== undefined && v !== "" && v !== "infinity";
  return set(props.MemoryHigh) || set(props.MemoryMax) || set(props.CPUQuotaPerSecUSec);
}

/** Parse a `/proc/pressure/<res>` file's `some avg10=` value (the standard some-stalled
 *  indicator), or null when absent/unparseable. */
export function parsePsiAvg10(psi: string): number | null {
  const some = psi.split("\n").find((l) => l.startsWith("some "));
  const m = some?.match(/avg10=(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

/** Parse MemTotal (bytes) from `/proc/meminfo`; null when the field is missing. */
export function parseMemTotal(meminfo: string): number | null {
  const m = meminfo.match(/^MemTotal:\s+(\d+)\s+kB/m);
  return m ? Number(m[1]) * 1024 : null;
}

/** Parse swap totals (bytes) from `/proc/meminfo`; null when the fields are missing. */
export function parseSwap(meminfo: string): { total: number; used: number } | null {
  const kb = (key: string): number | null => {
    const m = meminfo.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m"));
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb("SwapTotal");
  const free = kb("SwapFree");
  if (total === null || free === null) return null;
  return { total, used: Math.max(0, total - free) };
}

/** Dangerous live pressure. PSI (kernel stall time) is authoritative; swap-used ALONE never
 *  fires (zram / proactive eviction sit at 90%+ swap with ~0 PSI). A saturated swap only lowers
 *  the memory-PSI bar (corroboration). No `/proc/pressure` ⇒ can't assess ⇒ not dangerous. */
function isDangerousPressure(f: HostCapacityFacts): boolean {
  const p = f.pressure;
  if (!p) return false;
  if (p.memory !== null && p.memory >= HOST_PSI_MEMORY_AVG10) return true;
  if (p.io !== null && p.io >= HOST_PSI_IO_AVG10) return true;
  const swapSaturated =
    f.swap !== null && f.swap.total > 0 && f.swap.used / f.swap.total >= HOST_SWAP_SATURATION_RATIO;
  return swapSaturated && p.memory !== null && p.memory >= HOST_PSI_MEMORY_AVG10_CORROBORATED;
}

/** Map host facts → check. Precedence: dangerous pressure (error, any inspectable host) beats the
 *  guardrail verdict. Uninspectable (non-systemd / non-Linux / limits unreadable) is `optional`
 *  — a deliberate divergence from the issue's `warning` so local `bun run` boxes don't pin a
 *  permanent yellow health pip; genuine pressure still errors on those hosts. */
export function classifyHostCapacity(f: HostCapacityFacts): DiagnosticCheck {
  const id = "host_capacity";
  if (isDangerousPressure(f)) {
    return { id, state: "error", hintKey: "diagnostics_hint_host_capacity_pressure" };
  }
  if (f.unit !== null && f.limited !== null) {
    // `ok` only when Shepherd's unit is bounded AND herdr is bounded-or-unknown — so the green pip
    // durably reflects both units, not just Shepherd's (#1839). A positively-unbounded herdr keeps
    // the row `warning` even when Shepherd itself is bounded.
    if (f.limited && f.herdrLimited !== false) {
      return { id, state: "ok", hintKey: "diagnostics_hint_host_capacity_ok" };
    }
    // The currently-unbounded, one-click-fixable units. A unit that is already limited or unknown is
    // NOT listed — the fix never overwrites a deliberate operator limit nor touches an unknown unit.
    const units: string[] = [];
    if (!f.limited) units.push(f.unit);
    if (f.herdrLimited === false) units.push(HERDR_UNIT);
    // Distinct hint when only herdr is unbounded — the generic "no guardrails" copy would misdescribe
    // a bounded Shepherd.
    const check: DiagnosticCheck = {
      id,
      state: "warning",
      hintKey: f.limited ? HOST_CAPACITY_HERDR_UNBOUNDED_HINT : HOST_CAPACITY_UNBOUNDED_HINT,
    };
    // Offer the fix only on a user-scoped, tunable host with at least one unbounded unit. The values
    // are carried on the check so the modal reviews — and `fix()` applies — exactly what was computed.
    if (
      f.userScope &&
      f.memTotal !== null &&
      f.memTotal >= MIN_TUNABLE_MEMTOTAL &&
      units.length > 0
    ) {
      const { memoryHigh, cpuQuota } = proposeHostLimits(f.memTotal, f.cpuCount);
      check.fixActionKey = HOST_CAPACITY_FIX_ACTION;
      check.fixActionParams = { units: units.join(" "), memoryHigh, cpuQuota };
    }
    return check;
  }
  return { id, state: "optional", hintKey: "diagnostics_hint_host_capacity_uninspectable" };
}

/** Default slices that carry no intentional guardrail — a `Slice=` among these is not worth a
 *  second `systemctl show`. A custom slice (e.g. the recommended `shepherd.slice`) is. */
const DEFAULT_SLICES = new Set(["-.slice", "user.slice", "app.slice", "system.slice"]);

/** Default `readHostResources`: read the cgroup unit + its (and a custom slice's) systemd limits,
 *  swap totals, and memory/io PSI. Every read is independently guarded so a partial failure still
 *  yields useful facts (e.g. systemctl absent but `/proc` readable ⇒ pressure detection still
 *  works). On a non-Linux host every read throws ⇒ all-null facts ⇒ `optional` uninspectable. */
async function defaultReadHostResources(): Promise<HostCapacityFacts> {
  let unit: string | null = null;
  let userScope = false;
  try {
    ({ unit, userScope } = parseCgroupUnit(await readFile("/proc/self/cgroup", "utf8")));
  } catch {
    /* non-Linux / no cgroup v2 ⇒ unit stays null */
  }

  // `asUser` is explicit (not the closed-over `userScope`) so the herdr read can force `--user`
  // regardless of Shepherd's scope — a loaded user herdr is the only thing the `--user` fix can act on.
  const showLimits = async (target: string, asUser: boolean): Promise<Record<string, string>> => {
    const { stdout } = await execFileAsync(
      "systemctl",
      [
        ...(asUser ? ["--user"] : []),
        "show",
        target,
        "-p",
        "LoadState",
        "-p",
        "MemoryHigh",
        "-p",
        "MemoryMax",
        "-p",
        "CPUQuotaPerSecUSec",
        "-p",
        "TasksMax",
        "-p",
        "Slice",
      ],
      { encoding: "utf8", timeout: DIAGNOSTICS_PROBE_TIMEOUT_MS },
    );
    return parseSystemctlShow(stdout.toString());
  };

  // Fold a custom slice's limit into a unit-level `false`: a unit with no direct limit still counts as
  // bounded when it sits under a bounded custom slice (e.g. the recommended `shepherd.slice`).
  const withSlice = async (
    base: boolean,
    props: Record<string, string>,
    asUser: boolean,
  ): Promise<boolean> => {
    if (base) return true;
    const slice = props.Slice;
    if (slice && !DEFAULT_SLICES.has(slice)) {
      try {
        return hasMeaningfulLimit(await showLimits(slice, asUser));
      } catch {
        /* slice unreadable ⇒ keep the service-level verdict (false) */
      }
    }
    return base;
  };

  // null (not false) when the unit is known but its limits can't be read — classify then treats
  // the guardrail verdict as unknown (uninspectable) rather than a false `unbounded`.
  let limited: boolean | null = null;
  if (unit) {
    try {
      const props = await showLimits(unit, userScope);
      limited = await withSlice(hasMeaningfulLimit(props), props, userScope);
    } catch {
      limited = null; // systemctl absent/failed ⇒ unknown, not unbounded
    }
  }

  // herdr.service is only read on the userScope path (the fix is user-only) and always via `--user`.
  // `herdrLimitFromProps` maps a non-loaded unit (absent / masked / system-scoped) to null so it is
  // excluded from both the verdict and the fix — no spurious warning, no un-appliable button (#1839).
  let herdrLimited: boolean | null = null;
  if (userScope) {
    try {
      const props = await showLimits(HERDR_UNIT, true);
      const base = herdrLimitFromProps(props);
      herdrLimited = base === null ? null : await withSlice(base, props, true);
    } catch {
      herdrLimited = null; // systemctl absent/failed ⇒ unknown
    }
  }

  let swap: { total: number; used: number } | null = null;
  let memTotal: number | null = null;
  try {
    const meminfo = await readFile("/proc/meminfo", "utf8");
    swap = parseSwap(meminfo);
    memTotal = parseMemTotal(meminfo);
  } catch {
    /* no /proc/meminfo */
  }

  const readPsi = async (res: string): Promise<number | null> => {
    try {
      return parsePsiAvg10(await readFile(`/proc/pressure/${res}`, "utf8"));
    } catch {
      return null;
    }
  };
  const [memory, io] = await Promise.all([readPsi("memory"), readPsi("io")]);
  const pressure = memory !== null || io !== null ? { memory, io } : null;

  return {
    unit,
    userScope,
    limited,
    herdrLimited,
    swap,
    pressure,
    memTotal,
    cpuCount: cpus().length,
  };
}

/** Default `applyHostLimits`: `systemctl --user set-property <unit> MemoryHigh=… CPUQuota=…` per
 *  (de-duped) unit — live + persistent, no restart. `--user` is always valid: a fix is only emitted
 *  for a user-scoped Shepherd, and herdr is only listed once `--user show` proved it a loaded user
 *  unit. execFile argv (no shell) + server-computed limit strings ⇒ no injection surface (#1839). */
async function defaultApplyHostLimits(
  units: string[],
  { memoryHigh, cpuQuota }: { memoryHigh: string; cpuQuota: string },
): Promise<void> {
  for (const unit of new Set(units)) {
    await execFileAsync(
      "systemctl",
      ["--user", "set-property", unit, `MemoryHigh=${memoryHigh}`, `CPUQuota=${cpuQuota}`],
      { encoding: "utf8", timeout: DIAGNOSTICS_PROBE_TIMEOUT_MS },
    );
  }
}

// ── herdr_health check (#1835) ────────────────────────────────────────────────
// Diagnose-only runtime-hygiene / Soll-Ist reconciliation: correlate active Shepherd sessions
// against the herdr agent fleet and warn when an unclaimed, non-helper pane still holds a LIVE
// foreground process — a genuine leftover/zombie. It NEVER flags a running/pending session (its
// agent is claimed), a Shepherd helper agent, or a shell-only husk (the tab-reaper's domain).
// Pure scan — no kills, no pane-close. Payload purity holds: only counts cross into
// `HerdrFleetFacts`, never into the snapshot; the probe emits only {id,state,hintKey}. The systemd
// "Tasks" figure (threads, not processes) is deliberately NOT read here — it is not an alarm; the
// threads≠processes caveat is carried by the `herdr-hygiene` glossary term, and any numeric read is
// the drill-down follow-up.

/** Non-secret herdr-fleet facts, produced by `readHerdrFleet`, classified by `classifyHerdrFleet`.
 *  Counts only — never crosses into the snapshot. */
export interface HerdrFleetFacts {
  /** Unclaimed, non-helper panes whose foreground holds a LIVE (non-shell) process — the
   *  leftover/zombie signal. Drives the warning. */
  orphanLive: number;
  /** Unclaimed, non-helper panes that are shell-only husks (no live process). Measured for the
   *  shell-vs-live distinction (and the future drill-down); does NOT drive state — husks are the
   *  tab-reaper's domain and counting them here would over-fire the warning. */
  orphanHusk: number;
}

/** Map herdr-fleet facts → check. Only a live leftover proc warrants the hygiene warning; a
 *  shell-only husk (`orphanHusk`) is benign here. Uninspectable (herdr unreachable) is produced by
 *  the probe's `onTimeout`, not here. */
export function classifyHerdrFleet(f: HerdrFleetFacts): DiagnosticCheck {
  const id = "herdr_health";
  return f.orphanLive > 0
    ? { id, state: "warning", hintKey: "diagnostics_hint_herdr_health_leftover" }
    : { id, state: "ok", hintKey: "diagnostics_hint_herdr_health_ok" };
}

// ── tmp_inodes check (#1862) ─────────────────────────────────────────────────
// A tmpfs caps INODES independently of bytes, so an agent that puts a worktree + dependency
// install on it can exhaust the table while `df -h` still shows the volume mostly empty. Every
// write then fails ENOSPC and the session is effectively bricked — a failure that reads as "disk
// full" and sends operators the wrong way. This row names the real cause.

/** `fixActionKey` for the tmp_inodes one-click forced sweep. Dispatched in `fix()`, and registered
 *  in the UI's `codeFixChrome` map — an unregistered key falls back to the generic `*_code`
 *  strings, which are folder-trust copy. */
const TMP_INODES_FIX_ACTION = "diagnostics_fix_action_tmp_inodes";

/** Non-secret inode facts for the `tmp_inodes` check: use% of the temp filesystem, or `null` when
 *  it cannot be determined (no `statfs`; or a btrfs tmp reporting `files: 0`, since it allocates
 *  inodes dynamically and a percentage is meaningless there). Bands are passed in rather than read
 *  from env here so the classifier stays pure and testable. */
export interface TmpInodeFacts {
  usePct: number | null;
  /** Warning band — `SHEPHERD_TMP_INODE_PCT`, the SAME knob that gates the sweep. */
  warnPct: number;
  /** Error band — `TMP_INODE_ERROR_PCT`. */
  errorPct: number;
}

/** Map inode facts → check. `null` use% is `optional`/uninspectable (never degrades the health
 *  pip) — matching the `host_capacity` precedent for a host we cannot assess. The row warns at
 *  exactly the point the sweeper starts acting, so an operator who raised `SHEPHERD_TMP_INODE_PCT`
 *  is not warned about a state they deliberately told the sweeper to ignore. */
export function classifyTmpInodes(f: TmpInodeFacts): DiagnosticCheck {
  const id = "tmp_inodes";
  if (f.usePct === null) {
    return { id, state: "optional", hintKey: "diagnostics_hint_tmp_inodes_uninspectable" };
  }
  if (f.usePct >= f.errorPct) {
    return {
      id,
      state: "error",
      hintKey: "diagnostics_hint_tmp_inodes_critical",
      fixActionKey: TMP_INODES_FIX_ACTION,
    };
  }
  if (f.usePct >= f.warnPct) {
    return {
      id,
      state: "warning",
      hintKey: "diagnostics_hint_tmp_inodes_high",
      fixActionKey: TMP_INODES_FIX_ACTION,
    };
  }
  return { id, state: "ok", hintKey: "diagnostics_hint_tmp_inodes_ok" };
}

/** Default `readTmpInodes`: statfs the temp filesystem and pair it with the live bands. */
async function defaultReadTmpInodes(): Promise<TmpInodeFacts> {
  return {
    usePct: await readTmpInodeUsePct(),
    warnPct: tmpInodeWarnPct(),
    errorPct: TMP_INODE_ERROR_PCT,
  };
}

/** Default `runTmpSweep`: the operator's forced sweep. `thresholdPct: 0` bypasses the inode gate
 *  entirely, so an unreadable/btrfs temp filesystem cannot silently suppress an explicit request.
 *  A FUNCTIONAL default deliberately — it needs nothing the service does not already have, so
 *  `index.ts` requires no wiring and there is no untestable call site. */
async function defaultRunTmpSweep(): Promise<void> {
  await sweepClaudeTmp({ thresholdPct: 0 });
}

/** Resolve both tmp_inodes deps in one place, mirroring `resolveClaudeTrustDeps`. Grouping them
 *  keeps the already-long `DiagnosticsService` constructor from growing another two branches — the
 *  complexity gate is measured on that constructor, and a per-dep `??` there is what pushes it. */
function resolveTmpSweepDeps(deps: DiagnosticsDeps): {
  readTmpInodes: () => Promise<TmpInodeFacts>;
  runTmpSweep: () => Promise<void>;
} {
  return {
    readTmpInodes: deps.readTmpInodes ?? defaultReadTmpInodes,
    runTmpSweep: deps.runTmpSweep ?? defaultRunTmpSweep,
  };
}

/** Default `readHerdrFleet`: reconcile active sessions against the herdr fleet and count unclaimed,
 *  non-helper panes by foreground-process liveness. `listAsync` rejects when herdr is unreachable →
 *  the probe's `onTimeout` uninspectable fallback. A pane adopted by a live session (`matchAgents`)
 *  is skipped — a running/pending session is never a leak. Shepherd's own short-lived helper agents
 *  are skipped via `isShepherdHelperLabel` (they legitimately register with no session and are reaped
 *  by the tab-reaper). Per-orphan `paneForegroundProcs` is fail-closed: a throw or empty proc list is
 *  skipped (never counted on no evidence), mirroring `reapOrphanTabs`. */
export async function defaultReadHerdrFleet(
  store: Pick<SessionStore, "list">,
  herdr: Pick<IHerdrDriver, "listAsync" | "paneForegroundProcs">,
): Promise<HerdrFleetFacts> {
  const sessions = store.list({ activeOnly: true });
  const agents = await herdr.listAsync();
  const matched = matchAgents(sessions, agents);
  const claimed = new Set<string>();
  for (const a of matched.values()) if (a) claimed.add(a.terminalId);

  let orphanLive = 0;
  let orphanHusk = 0;
  for (const a of agents) {
    if (claimed.has(a.terminalId)) continue; // adopted by a live session — never a leak
    if (isShepherdHelperLabel(a.name)) continue; // Shepherd's own helper agents (reaped elsewhere)
    let procs: string[];
    try {
      procs = await herdr.paneForegroundProcs(a.paneId);
    } catch {
      continue; // transient read failure — fail closed, never count on no evidence
    }
    if (procs.length === 0) continue; // undeterminable — fail closed
    if (procs.every((n) => SHELLS.has(n))) orphanHusk++;
    else orphanLive++;
  }
  return { orphanLive, orphanHusk };
}

/**
 * Server-side environment-readiness diagnostics (issue #623). Fans dependency
 * probes with `Promise.all` behind a TTL cache. Mirrors HerdrUpdateService:
 * injectable runners for unit tests, `check(now)` (force re-run), `current(now)`
 * (TTL-cached read).
 *
 * **Payload purity:** every probe returns exactly `{ id, state, hintKey }` where
 * `hintKey` is a UI message-key STRING. No raw stdout, tokens, absolute paths, or
 * account identity ever crosses into the snapshot — the gh probe inspects exit
 * code only, the tailscale probe parses structured output into tri-state.
 *
 * **Timeout discipline:** each probe is wrapped so a timeout/throw RESOLVES to its
 * defined non-OK state — the `Promise.all` batch never rejects.
 */
export class DiagnosticsService {
  private runVersion: (bin: string, args: string[]) => Promise<string>;
  private runHerdrLiveness: () => Promise<void>;
  private runGhAuth: () => Promise<void>;
  private ghProbeAttempts: number;
  private ghProbeRetryDelayMs: number;
  private resolveHost: () => Promise<string | null>;
  private runServeStatus: () => Promise<string>;
  private runRemediation: (cmd: string) => Promise<void>;
  private anyForgeRepo: () => boolean;
  private anyLightweightRepo: () => boolean;
  private detectCodexAuthMode: () => CodexAuthMode;
  private configuredCodexModels: () => readonly (string | null)[];
  private readClaudeTrusted: () => Promise<boolean>;
  private trustClaude: () => Promise<void>;
  private isApiKeyAuth: () => boolean;
  private readHostResources: () => Promise<HostCapacityFacts>;
  private readHerdrFleet: () => Promise<HerdrFleetFacts>;
  private readTmpInodes: () => Promise<TmpInodeFacts>;
  private runTmpSweep: () => Promise<void>;
  private applyHostLimits: (
    units: string[],
    limits: { memoryHigh: string; cpuQuota: string },
  ) => Promise<void>;
  private last: DiagnosticsSnapshot | null = null;
  private lastAt = 0;

  constructor(deps: DiagnosticsDeps = {}) {
    this.runVersion =
      deps.runVersion ??
      (async (bin, args) => {
        const { stdout } = await execFileAsync(bin, args, {
          encoding: "utf8",
          timeout: DIAGNOSTICS_PROBE_TIMEOUT_MS,
        });
        return stdout.toString();
      });
    this.runHerdrLiveness =
      deps.runHerdrLiveness ??
      (() => defaultHerdrLiveness(config.herdrBin, DIAGNOSTICS_PROBE_TIMEOUT_MS));
    this.runGhAuth =
      deps.runGhAuth ??
      (async () => {
        // exit code only — stdout (which carries the logged-in account) is dropped.
        // A dedicated, shorter timeout than the generic probe budget keeps the retry
        // loop bounded (see config `GH_PROBE_*`). On timeout execFile SIGTERMs the child,
        // so the reject carries `killed:true` / `signal` — `ghProbe` reads that to tell a
        // transient stall apart from a real non-zero auth verdict.
        await execFileAsync("gh", ["auth", "status"], {
          encoding: "utf8",
          timeout: GH_PROBE_TIMEOUT_MS,
        });
      });
    this.ghProbeAttempts = deps.ghProbeAttempts ?? GH_PROBE_ATTEMPTS;
    this.ghProbeRetryDelayMs = deps.ghProbeRetryDelayMs ?? GH_PROBE_RETRY_DELAY_MS;
    this.resolveHost = deps.resolveHost ?? (() => resolveNodeHost());
    this.runServeStatus =
      deps.runServeStatus ??
      (async () => {
        const { stdout } = await execFileAsync("tailscale", ["serve", "status", "--json"], {
          encoding: "utf8",
          timeout: DIAGNOSTICS_PROBE_TIMEOUT_MS,
        });
        return stdout.toString();
      });
    this.runRemediation = deps.runRemediation ?? defaultRunRemediation;
    this.anyForgeRepo = deps.anyForgeRepo ?? (() => true);
    this.anyLightweightRepo = deps.anyLightweightRepo ?? (() => false);
    this.detectCodexAuthMode = deps.readCodexAuthMode ?? readCodexAuthMode;
    this.configuredCodexModels = deps.configuredCodexModels ?? (() => []);
    const trust = resolveClaudeTrustDeps(deps);
    this.readClaudeTrusted = trust.readClaudeTrusted;
    this.trustClaude = trust.trustClaude;
    this.isApiKeyAuth = trust.isApiKeyAuth;
    this.readHostResources = deps.readHostResources ?? defaultReadHostResources;
    // No functional default: `defaultReadHerdrFleet` needs the store + herdr driver, which this
    // service doesn't hold, so the real read is wired in `index.ts`. Unwired, the fail-safe reject
    // resolves the probe to its `optional`/uninspectable `onTimeout` — never a false ok/warning.
    this.readHerdrFleet =
      deps.readHerdrFleet ?? (() => Promise.reject(new Error("readHerdrFleet unwired")));
    this.applyHostLimits = deps.applyHostLimits ?? defaultApplyHostLimits;
    const tmpSweep = resolveTmpSweepDeps(deps);
    this.readTmpInodes = tmpSweep.readTmpInodes;
    this.runTmpSweep = tmpSweep.runTmpSweep;
  }

  /**
   * Warn when a live-configured Codex role/global model would be rejected by the operator's
   * ChatGPT-account Codex login (the class behind silent recap failures). Returns the warning
   * check, or null when it does not apply (not chatgpt auth, or no configured model is
   * blocklisted) — so the check only surfaces as a real advisory, never as `ok` noise. Enumerates
   * the live per-role cli/model pairs + global default, then the injected repo/epic settings.
   * Role/global pairs are resolved UNCLAMPED (authMode "unknown") to see the model that WOULD be
   * spawned without the guard.
   */
  private codexModelAuthCheck(): DiagnosticCheck | null {
    if (this.detectCodexAuthMode() !== "chatgpt") return null;
    const pairs: Array<[string, string]> = [
      [config.recapCli, config.recapModel],
      [config.namerCli, config.namerModel],
      [config.autopilotCli, config.autopilotModel],
      [config.criticCli, config.criticModel],
      [config.docAgentCli, config.docAgentModel],
      ["inherit", "default"], // the global default provider and its matching model
    ];
    const roleOrGlobalHit = pairs.some(([cli, model]) => {
      const globalModelSetting =
        config.defaultAgentProvider === "codex" ? config.defaultCodexModel : config.defaultModel;
      const env = resolveRoleEnvironment(
        cli,
        model,
        config.defaultAgentProvider,
        globalModelSetting,
        config.fableAvailable,
        "default",
        "unknown",
      );
      return (
        env.provider === "codex" &&
        env.model !== null &&
        CHATGPT_INCOMPATIBLE_CODEX_MODELS.has(env.model)
      );
    });
    const configuredHit = this.configuredCodexModels().some(
      (model) => model !== null && CHATGPT_INCOMPATIBLE_CODEX_MODELS.has(model),
    );
    const hit = roleOrGlobalHit || configuredHit;
    return hit
      ? {
          id: "codex_model_auth",
          state: "warning",
          hintKey: "diagnostics_hint_codex_model_chatgpt_incompatible",
        }
      : null;
  }

  /** Parse a (major.minor.patch) out of arbitrary `--version` output; null if none. */
  private parseVersion(out: string): string | null {
    const m = SEMVER_RE.exec(out);
    return m ? m[1]! : null;
  }

  /** Shared tri-state version probe (herdr / bun / node): missing ⇒ error,
   *  below-floor ⇒ warning, else ok. Floors are advisory — never an error.
   *
   *  herdr additionally passes a `liveness` probe + an `offline` key: once the binary
   *  is confirmed present, a daemon that doesn't answer is `error` (offline). Offline
   *  outranks an outdated-version warning — a dead server is unusable now, a
   *  live-but-old one merely wants updating. bun / node pass neither and keep the
   *  binary-only tri-state. */
  private async versionProbe(
    id: string,
    bin: string,
    floor: string,
    keys: { ok: string; outdated: string; missing: string; offline?: string },
    liveness?: () => Promise<void>,
  ): Promise<DiagnosticCheck> {
    const out = await this.runVersion(bin, ["--version"]);
    const version = this.parseVersion(out);
    if (!version) return { id, state: "error", hintKey: keys.missing };
    if (liveness && keys.offline) {
      try {
        await liveness();
      } catch {
        return { id, state: "error", hintKey: keys.offline };
      }
    }
    if (compareSemver(version, floor) < 0) {
      return { id, state: "warning", hintKey: keys.outdated };
    }
    return { id, state: "ok", hintKey: keys.ok };
  }

  private herdrProbe = (): Promise<DiagnosticCheck> =>
    this.versionProbe(
      "herdr",
      config.herdrBin,
      HERDR_MIN_VERSION,
      {
        ok: "diagnostics_hint_herdr_ok",
        outdated: "diagnostics_hint_herdr_outdated",
        missing: "diagnostics_hint_herdr_missing",
        offline: "diagnostics_hint_herdr_offline",
      },
      this.runHerdrLiveness,
    );

  private bunProbe = (): Promise<DiagnosticCheck> =>
    this.versionProbe("bun", "bun", BUN_MIN_VERSION, {
      ok: "diagnostics_hint_bun_ok",
      outdated: "diagnostics_hint_bun_outdated",
      missing: "diagnostics_hint_bun_missing",
    });

  private nodeProbe = (): Promise<DiagnosticCheck> =>
    this.versionProbe("node", "node", NODE_MIN_VERSION, {
      ok: "diagnostics_hint_node_ok",
      outdated: "diagnostics_hint_node_outdated",
      missing: "diagnostics_hint_node_missing",
    });

  /** git is presence-only: a parseable `git --version` ⇒ ok, else error. */
  private gitProbe = async (): Promise<DiagnosticCheck> => {
    const out = await this.runVersion("git", ["--version"]);
    return this.parseVersion(out)
      ? { id: "git", state: "ok", hintKey: "diagnostics_hint_git_ok" }
      : { id: "git", state: "error", hintKey: "diagnostics_hint_git_missing" };
  };

  /** gh: presence + `gh auth status` disposition (NEVER its stdout). The probe is the
   *  reported false-alarm surface — `gh auth status` reads the token from the OS keyring,
   *  so a locked keyring / D-Bus stall / cold `gh` under load can transiently time out and
   *  used to render as a hard "not logged in". So it now RETRIES (bounded) and classifies
   *  by HOW the last attempt failed rather than what it printed:
   *    • success on any attempt ⇒ ok;
   *    • ENOENT ⇒ binary missing (deterministic, no retry);
   *    • timed-out / killed on every attempt (`killed`/`signal` set — gh never rendered a
   *      verdict) ⇒ a soft, honest `gh_unverified` warning + a server-side log of the
   *      disposition only (never stderr/stdout/identity);
   *    • otherwise (gh exited with a non-zero verdict: logged-out / invalid token / bad
   *      scopes) ⇒ the actionable `gh_not_authenticated` error.
   *  When no forge-mode repos are configured, every non-ok outcome downgrades to a
   *  `not_required` warning — gh is optional when all repos are lightweight. */
  private ghProbe = async (): Promise<DiagnosticCheck> => {
    const forge = this.anyForgeRepo();
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.ghProbeAttempts; attempt++) {
      try {
        await this.runGhAuth();
        return { id: "gh", state: "ok", hintKey: "diagnostics_hint_gh_ok" };
      } catch (err) {
        lastErr = err;
        // Binary missing is deterministic — no point retrying.
        if (isEnoent(err)) return ghFailure(forge, "error", "diagnostics_hint_gh_missing");
        // Only a killed/timed-out failure is worth retrying; a non-zero EXIT is gh's
        // deterministic auth verdict, so probing it again would just delay the same answer.
        if (!isTransientProbeFailure(err)) break;
        if (attempt < this.ghProbeAttempts) await delay(this.ghProbeRetryDelayMs);
      }
    }
    // A killed/signalled reject means gh never finished (transient timeout) — report the
    // soft "couldn't verify" state, not a false "not logged in". Otherwise gh exited with a
    // real non-zero verdict ⇒ actionable auth failure.
    if (isTransientProbeFailure(lastErr)) {
      // Log only when the warning actually surfaces (a forge repo needs gh); a
      // lightweight-only host downgrades to a benign not_required and shouldn't emit a
      // "could not be verified" line for a state the user never sees.
      if (forge) logGhUnverified(lastErr, this.ghProbeAttempts);
      return ghFailure(forge, "warning", "diagnostics_hint_gh_unverified");
    }
    return ghFailure(forge, "error", "diagnostics_hint_gh_not_authenticated");
  };

  /** git capability check for lightweight mode: requires git ≥ 2.38 for
   *  `git merge-tree --write-tree`. Only meaningful when at least one lightweight
   *  repo is configured — otherwise returns ok immediately. */
  private gitMergetreeProbe = async (): Promise<DiagnosticCheck> => {
    const out = await this.runVersion("git", ["--version"]);
    const v = parseGitVersion(out);
    if (!v || !gitVersionAtLeast(v, MIN_GIT_MAJOR, MIN_GIT_MINOR)) {
      return { id: "git_mergetree", state: "warning", hintKey: "diagnostics_hint_gitcap_old" };
    }
    return { id: "git_mergetree", state: "ok", hintKey: "diagnostics_hint_gitcap_ok" };
  };

  /** Claude Code and Codex are interchangeable agent runtimes for Shepherd:
   *  at least one must exist, the other is optional but still diagnosed. Both are
   *  PRESENCE-ONLY (no login/auth probe, no config-dir parsing). Claude presence
   *  ALSO gates the `claude_trust` folder-trust check (below).  */
  private agentCliProbes = async (): Promise<DiagnosticCheck[]> => {
    const [claudeOk, codexOk] = await Promise.all([
      this.runVersion("claude", ["--version"])
        .then(() => true)
        .catch(() => false),
      this.runVersion("codex", ["--version"])
        .then(() => true)
        .catch(() => false),
    ]);
    const anyAgentCli = claudeOk || codexOk;
    const checks: DiagnosticCheck[] = [
      claudeOk
        ? { id: "claude", state: "ok", hintKey: "diagnostics_hint_claude_ok" }
        : {
            id: "claude",
            state: anyAgentCli ? "optional" : "error",
            hintKey: anyAgentCli
              ? "diagnostics_hint_claude_optional"
              : "diagnostics_hint_claude_missing",
          },
      codexOk
        ? { id: "codex", state: "ok", hintKey: "diagnostics_hint_codex_ok" }
        : {
            id: "codex",
            state: anyAgentCli ? "optional" : "error",
            hintKey: anyAgentCli
              ? "diagnostics_hint_codex_optional"
              : "diagnostics_hint_codex_missing",
          },
    ];
    // Folder-trust surfacing (#1683) — ONLY under subscription auth with Claude present. In api-key
    // mode the /usage probe short-circuits (never spawns), so an untrusted path wedges nothing and
    // the warning would be spurious. When untrusted, carry a path-free `fixActionKey` (a code fix,
    // no shell command) so the row offers a one-click reseed of `config.repoRoot`'s trust flag.
    if (claudeOk && !this.isApiKeyAuth()) {
      checks.push(
        (await this.readClaudeTrusted())
          ? { id: "claude_trust", state: "ok", hintKey: "diagnostics_hint_claude_trust_ok" }
          : {
              id: "claude_trust",
              state: "warning",
              hintKey: CLAUDE_TRUST_UNTRUSTED_HINT,
              fixActionKey: "diagnostics_fix_action_claude_trust",
            },
      );
    }
    return checks;
  };

  /** tailscale: missing binary / not-logged-in (resolveNodeHost null) ⇒ error;
   *  logged-in but not serving the HUD's local port (findServedPort finds no
   *  mapping for config.port in `tailscale serve status --json`) ⇒ warning
   *  (advisory — Shepherd runs fine without serve, it only gates the
   *  remote-access nicety); serving via direct serve OR a Tailscale Service ⇒
   *  ok. Never forwards raw status output. */
  private tailscaleProbe = async (): Promise<DiagnosticCheck> => {
    const host = await this.resolveHost();
    if (!host) {
      return {
        id: "tailscale",
        state: "error",
        hintKey: "diagnostics_hint_tailscale_missing",
      };
    }
    const status = await this.runServeStatus();
    const served = findServedPort(status, config.port);
    if (served === null) {
      return {
        id: "tailscale",
        state: "warning",
        hintKey: "diagnostics_hint_tailscale_not_serving",
      };
    }
    return { id: "tailscale", state: "ok", hintKey: "diagnostics_hint_tailscale_ok" };
  };

  /** host_capacity (#1732): classify injected/read host-resource facts. Any read failure resolves
   *  to the probe's `onTimeout` (optional/uninspectable) via the `check()` wrapper. */
  private hostCapacityProbe = async (): Promise<DiagnosticCheck> =>
    classifyHostCapacity(await this.readHostResources());

  /** tmp_inodes (#1862): classify temp-filesystem inode facts. Any read failure resolves to the
   *  probe's `onTimeout` (optional/uninspectable) via the `check()` wrapper. */
  private tmpInodesProbe = async (): Promise<DiagnosticCheck> =>
    classifyTmpInodes(await this.readTmpInodes());

  /** herdr_health (#1835): classify the reconciled herdr-fleet facts. Any read failure (herdr
   *  unreachable, or the fail-safe reject when unwired) resolves to the probe's `onTimeout`
   *  (optional/uninspectable) via the `check()` wrapper. */
  private herdrHealthProbe = async (): Promise<DiagnosticCheck> =>
    classifyHerdrFleet(await this.readHerdrFleet());

  /** The probes, each paired with its timed-out non-OK fallback. The
   *  git_mergetree check is only added when at least one lightweight repo is
   *  configured — a conditional push so forge-only setups are unaffected. */
  private probes(): Array<{ run: Probe; onTimeout: DiagnosticCheck }> {
    const list: Array<{ run: Probe; onTimeout: DiagnosticCheck }> = [
      {
        run: this.herdrProbe,
        onTimeout: { id: "herdr", state: "error", hintKey: "diagnostics_hint_herdr_missing" },
      },
      {
        run: this.tailscaleProbe,
        onTimeout: {
          id: "tailscale",
          state: "error",
          hintKey: "diagnostics_hint_tailscale_missing",
        },
      },
      {
        run: this.gitProbe,
        onTimeout: { id: "git", state: "error", hintKey: "diagnostics_hint_git_missing" },
      },
      {
        run: this.ghProbe,
        // Defense-in-depth: ghProbe owns its own retry/timeout and no longer throws, but
        // an unexpected throw must still land on the soft "couldn't verify" state — never
        // a false "not logged in".
        onTimeout: {
          id: "gh",
          state: "warning",
          hintKey: "diagnostics_hint_gh_unverified",
        },
      },
      {
        run: this.bunProbe,
        onTimeout: { id: "bun", state: "error", hintKey: "diagnostics_hint_bun_missing" },
      },
      {
        run: this.nodeProbe,
        onTimeout: { id: "node", state: "error", hintKey: "diagnostics_hint_node_missing" },
      },
      {
        run: this.hostCapacityProbe,
        // A failed/timed-out host read = can't verify guardrails ⇒ optional (no pip degrade),
        // matching the classifier's uninspectable branch.
        onTimeout: {
          id: "host_capacity",
          state: "optional",
          hintKey: "diagnostics_hint_host_capacity_uninspectable",
        },
      },
      {
        run: this.herdrHealthProbe,
        // A failed/rejected fleet read = herdr unreachable (or unwired) ⇒ can't assess hygiene ⇒
        // optional/uninspectable (no pip degrade), matching classifyHerdrFleet's absent branch.
        onTimeout: {
          id: "herdr_health",
          state: "optional",
          hintKey: "diagnostics_hint_herdr_health_uninspectable",
        },
      },
      {
        run: this.tmpInodesProbe,
        // A failed/timed-out statfs = can't read inode pressure ⇒ optional (no pip degrade),
        // matching the classifier's own null/uninspectable branch.
        onTimeout: {
          id: "tmp_inodes",
          state: "optional",
          hintKey: "diagnostics_hint_tmp_inodes_uninspectable",
        },
      },
    ];
    if (this.anyLightweightRepo()) {
      list.push({
        run: this.gitMergetreeProbe,
        onTimeout: {
          id: "git_mergetree",
          state: "warning",
          hintKey: "diagnostics_hint_gitcap_old",
        },
      });
    }
    // Codex model↔auth advisory: only added when a configured codex model is chatgpt-incompatible,
    // so it never surfaces as `ok` noise. Synchronous + local, so run resolves the precomputed check.
    const codexAuth = this.codexModelAuthCheck();
    if (codexAuth) list.push({ run: async () => codexAuth, onTimeout: codexAuth });
    return list;
  }

  /** Force a fresh run of all probes; sets the TTL cache. A probe that throws /
   *  times out resolves to its defined non-OK fallback — the batch never rejects. */
  async check(now: number): Promise<DiagnosticsSnapshot> {
    const [checks, agentCliChecks] = await Promise.all([
      Promise.all(this.probes().map(({ run, onTimeout }) => run().catch(() => onTimeout))),
      this.agentCliProbes().catch((): DiagnosticCheck[] => [
        { id: "claude", state: "error", hintKey: "diagnostics_hint_claude_missing" },
        { id: "codex", state: "error", hintKey: "diagnostics_hint_codex_missing" },
      ]),
    ]);
    checks.splice(4, 0, ...agentCliChecks);
    // Annotate each non-ok, auto-fixable check with its verbatim Fix command. Only
    // attach the key when a command exists (guidance-only / ok stay absent), so
    // payload-purity expectations hold.
    for (const c of checks) {
      if (c.state === "ok") continue;
      const cmd = autoFixCommandFor(c.hintKey);
      if (cmd) c.remediation = cmd;
    }
    const snapshot: DiagnosticsSnapshot = {
      checks,
      generatedAt: now,
      overall: worstOf(checks),
    };
    this.last = snapshot;
    this.lastAt = now;
    return snapshot;
  }

  /** TTL-cached read: returns the cached snapshot when fresh, else re-`check`s. */
  current(now: number): Promise<DiagnosticsSnapshot> {
    if (this.last && now - this.lastAt < DIAGNOSTICS_TTL_MS) {
      return Promise.resolve(this.last);
    }
    return this.check(now);
  }

  /** Run the fix for `checkId`, then force a fresh probe and return the new snapshot. Three dispatch
   *  paths, all fail-closed (a rejection propagates so the caller maps it to an explicit failure,
   *  never a false pass):
   *   - **claude_trust code fix** (dispatched by hintKey): seeds `config.repoRoot`'s folder-trust flag
   *     — a dynamic path payload-purity keeps out of `remediation`, so it has no shell command.
   *     Read-gated (skips the write when already trusted); same whole-file clobber caveat as the
   *     /usage probe seed.
   *   - **host_capacity code fix** (dispatched by `fixActionKey`): `set-property` the carried
   *     `MemoryHigh`/`CPUQuota` on the carried unbounded units (#1839).
   *   - **shell remediation**: the verbatim command for the hintKey.
   *  Throws if the check is unknown or has no code fix and no auto-fix command. */
  async fix(checkId: string, now: number): Promise<DiagnosticsSnapshot> {
    const snapshot = await this.current(now);
    const check = snapshot.checks.find((c) => c.id === checkId);
    if (!check) throw new Error(`unknown check ${checkId}`);
    if (check.hintKey === CLAUDE_TRUST_UNTRUSTED_HINT) {
      if (!(await this.readClaudeTrusted())) await this.trustClaude(); // read-gated seed
      return this.check(now); // forced re-probe reflects the fix
    }
    // host_capacity code fix (#1839): dispatch on the fixActionKey (NOT hintKey — two warning
    // hintKeys can carry it) and apply exactly the units + values the snapshot check carried, so the
    // operator applies precisely what the confirm modal reviewed.
    if (check.fixActionKey === HOST_CAPACITY_FIX_ACTION && check.fixActionParams) {
      const { units, memoryHigh, cpuQuota } = check.fixActionParams;
      if (units && memoryHigh && cpuQuota) {
        await this.applyHostLimits(units.split(" ").filter(Boolean), { memoryHigh, cpuQuota });
        return this.check(now); // forced re-probe reflects the fix
      }
    }
    // tmp_inodes forced sweep (#1862): dispatch on the fixActionKey (two states carry it). The
    // sweep bypasses its own inode gate, so it acts even when the temp filesystem is unreadable —
    // but it only drops what this release knows how to reclaim, so the row commonly stays non-ok
    // (the unresolved-toast copy says so rather than blaming a stale check).
    if (check.fixActionKey === TMP_INODES_FIX_ACTION) {
      await this.runTmpSweep();
      return this.check(now); // forced re-probe reflects the fix
    }
    const cmd = autoFixCommandFor(check.hintKey);
    if (!cmd) throw new Error(`no remediation for ${checkId}`);
    await this.runRemediation(cmd); // rejection propagates → fail closed
    return this.check(now); // forced re-probe reflects the fix
  }
}
