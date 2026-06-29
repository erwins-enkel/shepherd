import { spawn } from "node:child_process";
import { execFileSync } from "./instrument";
import { config } from "./config";
import { compareSemver } from "./herdr-update";
import type { CodexUpdateStatus } from "./types";

export type { CodexUpdateStatus };

const SEMVER_RE = /(\d+\.\d+\.\d+)/;
/** npm registry manifest for the latest published @openai/codex. Returns the
 *  full packument for the `latest` dist-tag, which carries the `version` field. */
const LATEST_URL = "https://registry.npmjs.org/@openai/codex/latest";

/** Prefix every step marker the update script echoes. Stable + greppable so the
 *  operator can `cat ~/.shepherd/codex-update.log | grep '>>> codex-update'` and
 *  read the exact sequence (and exit code) even after shepherd has restarted. */
export const CODEX_UPDATE_LOG_PREFIX = ">>> codex-update:";

/** Versions are regex-captured (digits + dots) before they reach here, but they
 *  ultimately originate from the npm registry — an external source. Strip
 *  anything that isn't a version char before embedding in the shell program so a
 *  poisoned payload can never inject commands. Empty → "unknown". */
function sanitizeVersion(v: string | null | undefined): string {
  const clean = (v ?? "").replace(/[^0-9.]/g, "");
  return clean || "unknown";
}

/**
 * The shell program shepherd spawns as a managed child. Extracted + exported
 * so its sequencing is unit-testable without a live codex release.
 *
 * Unlike `herdr update`, `npm install -g @openai/codex` is NON-destructive: it
 * swaps the global binary on disk, so already-spawned codex agent panes keep
 * running their loaded build and only NEW codex sessions pick up the new
 * version. There is therefore no handoff, no server restart, and no recovery
 * branch — just install + audit.
 *
 * Every run appends ONE delimited block to `logPath` (default
 * ~/.shepherd/codex-update.log) via `tee -a`: a `=== codex-update <UTC> <from>
 * -> <to> ===` header, the step marker, raw `npm install` output, and the exit
 * code. The script writes this file itself so the record is COMPLETE even if
 * shepherd crashes mid-update.
 */
export function buildUpdateScript(
  logPath: string,
  from?: string | null,
  to?: string | null,
): string {
  const f = sanitizeVersion(from);
  const t = sanitizeVersion(to);
  // single-quote the path for the shell; a literal `'` inside it (vanishingly
  // unlikely in a home path) is escaped via the classic '\'' close-reopen trick.
  const q = `'${logPath.replace(/'/g, "'\\''")}'`;
  return [
    `LOG=${q}`,
    'mkdir -p "$(dirname "$LOG")"',
    "{",
    `  echo "=== codex-update $(date -u +%Y-%m-%dT%H:%M:%SZ) ${f} -> ${t} ==="`,
    `  echo '${CODEX_UPDATE_LOG_PREFIX} running npm install -g @openai/codex'`,
    "  npm install -g @openai/codex; rc=$?",
    `  echo "${CODEX_UPDATE_LOG_PREFIX} npm install exited rc=$rc"`,
    '} 2>&1 | tee -a "$LOG"',
  ].join("\n");
}

/** Terminal outcome of an apply(), emitted once via onDone. Drives the modal's
 *  ✓/✗ state. Success is decided by a re-read `codex --version`, NOT the child's
 *  exit code (a no-op `npm install` still exits 0). */
export interface CodexUpdateResult {
  ok: boolean;
  from: string | null;
  to: string | null;
  error?: string;
}

export interface CodexUpdateDeps {
  /** inject point for tests; defaults to running the codex binary's --version */
  versionRunner?: () => string;
  /** inject point for tests; defaults to fetching the npm registry manifest */
  fetchLatest?: () => Promise<{ version: string }>;
  /**
   * Run the update child, streaming each output line to onLine, resolving when
   * it exits. The AbortSignal fires on watchdog timeout — the default kills the
   * child. Default: spawn `bash -lc <buildUpdateScript>`.
   */
  runUpdate?: (onLine: (line: string) => void, signal: AbortSignal) => Promise<void>;
  /** each log line streamed from the running update; default: no-op */
  onLog?: (line: string) => void;
  /** the recomputed status after the update settles; default: no-op */
  onStatus?: (status: CodexUpdateStatus) => void;
  /** the terminal result, emitted exactly once per apply(); default: no-op */
  onDone?: (result: CodexUpdateResult) => void;
  /** watchdog ceiling before a hung `npm install` is force-killed (default 5min) */
  watchdogMs?: number;
}

/**
 * Tracks whether a newer @openai/codex (the OpenAI Codex CLI, one of Shepherd's
 * agent runtimes) is published on npm and, on demand, runs `npm install -g
 * @openai/codex` for the operator. It surfaces a badge keyed off
 * `updateAvailable`.
 *
 * Modelled on {@link HerdrUpdateService}: the check parses the installed version
 * from `codex --version` and compares it against the npm registry. It is
 * fail-safe — any error (binary missing, network down, malformed payload) yields
 * updateAvailable:false, so a broken check can never raise a false badge.
 *
 * `apply()` spawns the install as a managed child of shepherd (no shepherd
 * restart). Because the install is non-destructive, running codex panes are not
 * interrupted. Success is determined by re-reading `codex --version` after the
 * child exits, not by exit code. The terminal result is emitted via onDone.
 */
export class CodexUpdateService {
  private versionRunner: () => string;
  private fetchLatest: () => Promise<{ version: string }>;
  private runUpdate: (onLine: (line: string) => void, signal: AbortSignal) => Promise<void>;
  private onLog: (line: string) => void;
  private onStatus: (status: CodexUpdateStatus) => void;
  private onDone: (result: CodexUpdateResult) => void;
  private watchdogMs: number;
  private last: CodexUpdateStatus | null = null;
  private applying = false;

  constructor(deps: CodexUpdateDeps = {}) {
    this.versionRunner =
      deps.versionRunner ??
      (() => execFileSync(config.codexBin, ["--version"], { encoding: "utf8" }));
    this.fetchLatest =
      deps.fetchLatest ??
      (() => fetch(LATEST_URL).then((r) => r.json() as Promise<{ version: string }>));
    this.runUpdate = deps.runUpdate ?? ((onLine, signal) => this.defaultRunUpdate(onLine, signal));
    this.onLog = deps.onLog ?? (() => {});
    this.onStatus = deps.onStatus ?? (() => {});
    this.onDone = deps.onDone ?? (() => {});
    this.watchdogMs = deps.watchdogMs ?? 5 * 60 * 1000;
  }

  /** Spawn `bash -lc <script>` in shepherd's own process tree (NOT detached —
   *  there is no shepherd restart to outlive), stream stdout+stderr to onLine,
   *  resolve on exit. The signal (watchdog) force-kills a hung child. */
  private defaultRunUpdate(onLine: (line: string) => void, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const script = buildUpdateScript(
        config.codexUpdateLogPath,
        this.last?.current,
        this.last?.latest,
      );
      const child = spawn("bash", ["-lc", script], { stdio: ["ignore", "pipe", "pipe"] });
      const kill = () => child.kill("SIGKILL");
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });

      let buf = "";
      const handleChunk = (chunk: Buffer | string) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trimEnd();
          if (trimmed) onLine(trimmed);
        }
      };
      child.stdout?.on("data", handleChunk);
      child.stderr?.on("data", handleChunk);
      const finish = () => {
        signal.removeEventListener("abort", kill);
        if (buf.trim()) onLine(buf.trim());
        resolve();
      };
      child.on("exit", finish);
      child.on("error", (err) => {
        onLine(`codex update spawn failed: ${err.message}`);
        finish();
      });
    });
  }

  /** Parse the installed version from `codex --version`; null if unreadable. */
  private installedVersion(): string | null {
    const m = SEMVER_RE.exec(this.versionRunner());
    return m ? m[1]! : null;
  }

  /** Best-effort installed version for the "what are we ACTUALLY on?" report.
   *  Never throws (a missing/exploding `codex --version` falls back to `fallback`,
   *  the last-known-good). Used by every failure branch so we never tell the
   *  operator they're on the target version we know they did NOT reach. */
  private actualVersion(fallback: string | null): string | null {
    try {
      return this.installedVersion() ?? fallback;
    } catch {
      return fallback;
    }
  }

  /** Last computed status, or null before the first check. */
  current(): CodexUpdateStatus | null {
    return this.last;
  }

  /** Kick off the update in the background. Returns immediately so the HTTP
   *  endpoint can answer 202; progress streams via onLog and the terminal
   *  outcome via onDone. Guards against a double-launch while one is in flight. */
  apply(): { started: boolean } {
    if (this.applying) return { started: false };
    this.applying = true;
    console.warn(
      `[codex-update] applying ${this.last?.current ?? "?"} -> ${this.last?.latest ?? "?"}; ` +
        `Shepherd stays up (audit log: ${config.codexUpdateLogPath})`,
    );
    void this.runOnce();
    return { started: true };
  }

  /** Background body of apply(): run the update under a watchdog, decide success
   *  from a re-read version, emit status + a terminal result, and ALWAYS clear
   *  the applying guard in finally. */
  private async runOnce(): Promise<void> {
    const from = this.last?.current ?? null;
    const to = this.last?.latest ?? null;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let result: CodexUpdateResult;
    try {
      const ctrl = new AbortController();
      watchdog = setTimeout(() => ctrl.abort(), this.watchdogMs);
      await this.runUpdate((line) => this.onLog(line), ctrl.signal);
      // Re-read the installed version once: it decides success AND is the version
      // every failure branch reports as "what we're actually on" (never the
      // target, which we know we did not reach).
      const after = this.actualVersion(from);
      if (ctrl.signal.aborted) {
        result = { ok: false, from, to: after, error: "codex update timed out" };
      } else {
        const ok = !!after && !!to && after === to;
        this.last = {
          current: after,
          latest: to,
          updateAvailable: !!after && !!to && compareSemver(to, after) > 0,
          notes: null,
          checkedAt: Date.now(),
          error: ok ? undefined : "codex was not updated",
        };
        this.onStatus(this.last);
        result = ok
          ? { ok: true, from, to }
          : { ok: false, from, to: after, error: "codex was not updated" };
      }
    } catch (err) {
      // runUpdate itself threw (e.g. spawn failed) — re-read the actual version
      // so we don't claim the target either.
      result = {
        ok: false,
        from,
        to: this.actualVersion(from),
        error: err instanceof Error ? err.message : "codex update failed",
      };
    } finally {
      clearTimeout(watchdog);
      this.applying = false;
    }
    this.onDone(result);
  }

  /** Re-read the installed codex version and the latest published one, then
   *  compare. On any failure returns updateAvailable:false with an error set. */
  async check(now: number): Promise<CodexUpdateStatus> {
    try {
      const currentMatch = SEMVER_RE.exec(this.versionRunner());
      const current = currentMatch ? currentMatch[1]! : null;

      const latestRaw = await this.fetchLatest();
      const latestMatch = latestRaw?.version ? SEMVER_RE.exec(latestRaw.version) : null;
      const latest = latestMatch ? latestMatch[1]! : null;

      const updateAvailable = !!current && !!latest && compareSemver(latest, current) > 0;

      this.last = {
        current,
        latest,
        updateAvailable,
        notes: null,
        checkedAt: now,
      };
    } catch (e) {
      this.last = {
        current: this.last?.current ?? null,
        latest: null,
        updateAvailable: false,
        notes: null,
        checkedAt: now,
        error: e instanceof Error ? e.message : "codex update check failed",
      };
    }
    return this.last;
  }
}
