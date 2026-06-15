import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  BUN_MIN_VERSION,
  DIAGNOSTICS_PROBE_TIMEOUT_MS,
  DIAGNOSTICS_TTL_MS,
  HERDR_MIN_VERSION,
  NODE_MIN_VERSION,
  REMEDIATION_TIMEOUT_MS,
  config,
  findServedPort,
} from "./config";
import { compareSemver } from "./herdr-update";
import { autoFixCommandFor } from "./remediations";
import { resolveNodeHost } from "./tailscale";
import type { DiagnosticCheck, DiagnosticsSnapshot, DiagnosticState } from "./types";

const execFileAsync = promisify(execFile);

/** Reused from herdr-update.ts's parsing discipline — a (major.minor.patch)
 *  capture. Kept local so the regex's lastIndex state is never shared. */
const SEMVER_RE = /(\d+\.\d+\.\d+)/;

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
  /** Run `gh auth status`; resolves on a zero exit, rejects on non-zero / timeout.
   *  Its stdout is intentionally discarded (it carries account identity). */
  runGhAuth?: () => Promise<void>;
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
}

/** A single probe: an async fn returning ONLY `{ id, state, hintKey }`. */
type Probe = () => Promise<DiagnosticCheck>;

const STATE_RANK: Record<DiagnosticState, number> = { ok: 0, warning: 1, error: 2 };

/** worst-of: error > warning > ok. Empty ⇒ ok. */
function worstOf(checks: DiagnosticCheck[]): DiagnosticState {
  let worst: DiagnosticState = "ok";
  for (const c of checks) {
    if (STATE_RANK[c.state] > STATE_RANK[worst]) worst = c.state;
  }
  return worst;
}

/** Cap on drained child output: just enough to keep a noisy `curl | bash` install
 *  from blocking on a full pipe, then dropped. NEVER surfaced to the client. */
const REMEDIATION_DRAIN_CAP = 1 << 20; // 1 MiB

/** Default `runRemediation`: spawn the verbatim command in its OWN process group
 *  (`detached`), drain stdout/stderr into a bounded sink (so a noisy install can't
 *  ENOBUFS or block on a full pipe), and SIGKILL the whole group on timeout. Resolves
 *  on exit 0, rejects otherwise — the rejection message is generic (no captured
 *  output / paths / identity ever reaches the caller). */
function defaultRunRemediation(cmd: string): Promise<void> {
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
    }, REMEDIATION_TIMEOUT_MS);
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

/**
 * Server-side environment-readiness diagnostics (issue #623). Fans 7 dependency
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
  private runGhAuth: () => Promise<void>;
  private resolveHost: () => Promise<string | null>;
  private runServeStatus: () => Promise<string>;
  private runRemediation: (cmd: string) => Promise<void>;
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
    this.runGhAuth =
      deps.runGhAuth ??
      (async () => {
        // exit code only — stdout (which carries the logged-in account) is dropped.
        await execFileAsync("gh", ["auth", "status"], {
          encoding: "utf8",
          timeout: DIAGNOSTICS_PROBE_TIMEOUT_MS,
        });
      });
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
  }

  /** Parse a (major.minor.patch) out of arbitrary `--version` output; null if none. */
  private parseVersion(out: string): string | null {
    const m = SEMVER_RE.exec(out);
    return m ? m[1]! : null;
  }

  /** Shared tri-state version probe (herdr / bun / node): missing ⇒ error,
   *  below-floor ⇒ warning, else ok. Floors are advisory — never an error. */
  private async versionProbe(
    id: string,
    bin: string,
    floor: string,
    keys: { ok: string; outdated: string; missing: string },
  ): Promise<DiagnosticCheck> {
    const out = await this.runVersion(bin, ["--version"]);
    const version = this.parseVersion(out);
    if (!version) return { id, state: "error", hintKey: keys.missing };
    if (compareSemver(version, floor) < 0) {
      return { id, state: "warning", hintKey: keys.outdated };
    }
    return { id, state: "ok", hintKey: keys.ok };
  }

  private herdrProbe = (): Promise<DiagnosticCheck> =>
    this.versionProbe("herdr", config.herdrBin, HERDR_MIN_VERSION, {
      ok: "diagnostics_hint_herdr_ok",
      outdated: "diagnostics_hint_herdr_outdated",
      missing: "diagnostics_hint_herdr_missing",
    });

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

  /** gh: presence + `gh auth status` exit code (NEVER its stdout). ENOENT ⇒
   *  binary missing; non-zero exit ⇒ not authenticated. Timeout propagates to the
   *  `probes()` catch which resolves to `diagnostics_hint_gh_not_authenticated`. */
  private ghProbe = async (): Promise<DiagnosticCheck> => {
    try {
      await this.runGhAuth();
      return { id: "gh", state: "ok", hintKey: "diagnostics_hint_gh_ok" };
    } catch (err) {
      if (err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return { id: "gh", state: "error", hintKey: "diagnostics_hint_gh_missing" };
      }
      return { id: "gh", state: "error", hintKey: "diagnostics_hint_gh_not_authenticated" };
    }
  };

  /** claude is PRESENCE-ONLY (brief No-Go: no login/auth probe, no ~/.claude
   *  parsing). A successful `claude --version` ⇒ ok, anything else ⇒ missing. */
  private claudeProbe = async (): Promise<DiagnosticCheck> => {
    await this.runVersion("claude", ["--version"]);
    return { id: "claude", state: "ok", hintKey: "diagnostics_hint_claude_ok" };
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

  /** The 7 probes, each paired with its timed-out non-OK fallback. */
  private probes(): Array<{ run: Probe; onTimeout: DiagnosticCheck }> {
    return [
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
        onTimeout: {
          id: "gh",
          state: "error",
          hintKey: "diagnostics_hint_gh_not_authenticated",
        },
      },
      {
        run: this.claudeProbe,
        onTimeout: { id: "claude", state: "error", hintKey: "diagnostics_hint_claude_missing" },
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
  }

  /** Force a fresh run of all 7 probes; sets the TTL cache. A probe that throws /
   *  times out resolves to its defined non-OK fallback — the batch never rejects. */
  async check(now: number): Promise<DiagnosticsSnapshot> {
    const checks = await Promise.all(
      this.probes().map(({ run, onTimeout }) => run().catch(() => onTimeout)),
    );
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

  /** Run the verbatim remediation for `checkId`'s current hintKey, then force a fresh
   *  probe and return the new snapshot. Throws if the check is unknown or has no
   *  auto-fix command (guidance-only / prose-only). A failing command REJECTS
   *  (fail-closed) — the caller maps that to an explicit failure, never a false pass. */
  async fix(checkId: string, now: number): Promise<DiagnosticsSnapshot> {
    const snapshot = await this.current(now);
    const check = snapshot.checks.find((c) => c.id === checkId);
    if (!check) throw new Error(`unknown check ${checkId}`);
    const cmd = autoFixCommandFor(check.hintKey);
    if (!cmd) throw new Error(`no remediation for ${checkId}`);
    await this.runRemediation(cmd); // rejection propagates → fail closed
    return this.check(now); // forced re-probe reflects the fix
  }
}
