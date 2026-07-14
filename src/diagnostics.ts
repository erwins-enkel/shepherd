import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  BUN_MIN_VERSION,
  DIAGNOSTICS_PROBE_TIMEOUT_MS,
  DIAGNOSTICS_TTL_MS,
  GH_PROBE_ATTEMPTS,
  GH_PROBE_RETRY_DELAY_MS,
  GH_PROBE_TIMEOUT_MS,
  HERDR_MIN_VERSION,
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

/**
 * Adaptive delay until the next background diagnostics re-check, chosen from the snapshot
 * just produced. ONLY an `error` accelerates to `recheckMs`: a hard error (canonically
 * herdr `offline`) is expected to be transient/recoverable, and the client only learns it
 * cleared from the next `diagnostics:status` push — so re-checking every `recheckMs` while
 * `error` persists lets a healthy-again host self-correct within ~one recheck instead of
 * staying pinned until the next `intervalMs`. `warning` deliberately stays on `intervalMs`:
 * it is steady-state by design (advisory version floors, gh-not-required on lightweight
 * hosts, `worstOf` never surfaces `optional` — it ranks 0, same as `ok`), so accelerating on
 * it would fast-poll forever with no path back to the steady cadence.
 */
export function nextDiagnosticsDelay(
  overall: DiagnosticState,
  intervalMs: number,
  recheckMs: number,
): number {
  return overall === "error" ? recheckMs : intervalMs;
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
      ["inherit", "default"], // the global default (defaultAgentProvider/defaultModel)
    ];
    const roleOrGlobalHit = pairs.some(([cli, model]) => {
      const env = resolveRoleEnvironment(
        cli,
        model,
        config.defaultAgentProvider,
        config.defaultModel,
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

  /** Run the fix for `checkId`'s current hintKey, then force a fresh probe and return
   *  the new snapshot. Two dispatch paths, both fail-closed (a rejection propagates so
   *  the caller maps it to an explicit failure, never a false pass):
   *   - **code fix** (dispatched by hintKey): the `claude_trust` untrusted check seeds
   *     `config.repoRoot`'s folder-trust flag — a dynamic path payload-purity keeps out
   *     of `remediation`, so it has no shell command. Read-gated (skips the write when
   *     already trusted); same whole-file clobber caveat as the /usage probe seed.
   *   - **shell remediation**: the verbatim command for the hintKey.
   *  Throws if the check is unknown or has neither a code fix nor an auto-fix command. */
  async fix(checkId: string, now: number): Promise<DiagnosticsSnapshot> {
    const snapshot = await this.current(now);
    const check = snapshot.checks.find((c) => c.id === checkId);
    if (!check) throw new Error(`unknown check ${checkId}`);
    if (check.hintKey === CLAUDE_TRUST_UNTRUSTED_HINT) {
      if (!(await this.readClaudeTrusted())) await this.trustClaude(); // read-gated seed
      return this.check(now); // forced re-probe reflects the fix
    }
    const cmd = autoFixCommandFor(check.hintKey);
    if (!cmd) throw new Error(`no remediation for ${checkId}`);
    await this.runRemediation(cmd); // rejection propagates → fail closed
    return this.check(now); // forced re-probe reflects the fix
  }
}
