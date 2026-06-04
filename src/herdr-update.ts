import { execFileSync, spawn } from "node:child_process";
import { config } from "./config";
import { maintenance as sharedMaintenance } from "./maintenance";
import type { HerdrUpdateStatus } from "./types";

export type { HerdrUpdateStatus };

/** Numeric major.minor.patch comparison. Returns >0 if a>b, <0 if a<b, 0 if equal.
 *  Missing/garbage segments coerce to 0, so "0.6" compares as "0.6.0". */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number(n) || 0);
  const pb = b.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

const SEMVER_RE = /(\d+\.\d+\.\d+)/;
const LATEST_URL = "https://herdr.dev/latest.json";

/** Prefix every step marker the update script echoes. Stable + greppable so the
 *  operator can `cat ~/.shepherd/herdr-update.log | grep '>>> herdr-update'` and
 *  read the exact sequence (and exit code) even after shepherd has restarted. */
export const UPDATE_LOG_PREFIX = ">>> herdr-update:";

/** Versions are regex-captured (digits + dots) before they reach here, but they
 *  ultimately originate from herdr.dev/latest.json — an external source. Strip
 *  anything that isn't a version char before embedding in the shell program so a
 *  poisoned payload can never inject commands. Empty → "unknown". */
function sanitizeVersion(v: string | null | undefined): string {
  const clean = (v ?? "").replace(/[^0-9.]/g, "");
  return clean || "unknown";
}

/**
 * The shell program shepherd spawns as a managed child. Extracted + exported
 * so its sequencing is unit-testable without a live herdr release.
 *
 * Two guarantees:
 *
 *  1. Every run appends ONE delimited block to `logPath` (default
 *     ~/.shepherd/herdr-update.log) via `tee -a`: a `=== herdr-update <UTC>
 *     <from> -> <to> ===` header, each step marker, raw `herdr update` output,
 *     and the exit code. The script writes this file itself so the record is
 *     COMPLETE even if shepherd crashes mid-update.
 *
 *  2. Each step echoes a `UPDATE_LOG_PREFIX` marker BEFORE it runs, and the
 *     `herdr update` exit code is echoed explicitly.
 *
 * Shepherd stays up during the update (no restart), so it captures this
 * script's stdout live for the modal. The `tee -a` keeps a durable post-mortem.
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
  // Shepherd stays up during the update (no restart), so it captures this
  // script's stdout live for the modal. The `tee -a` is kept anyway: it makes
  // `cat <logPath>` a durable post-mortem that survives even a shepherd crash.
  return [
    `LOG=${q}`,
    'mkdir -p "$(dirname "$LOG")"',
    "{",
    `  echo "=== herdr-update $(date -u +%Y-%m-%dT%H:%M:%SZ) ${f} -> ${t} ==="`,
    `  echo '${UPDATE_LOG_PREFIX} stopping herdr server'`,
    "  herdr server stop || true",
    `  echo '${UPDATE_LOG_PREFIX} running herdr update'`,
    "  herdr update; rc=$?",
    `  echo "${UPDATE_LOG_PREFIX} herdr update exited rc=$rc"`,
    '} 2>&1 | tee -a "$LOG"',
  ].join("\n");
}

/** Terminal outcome of an apply(), emitted once via onDone. Drives the modal's
 *  ✓/✗ state. Success is decided by a re-read `herdr --version`, NOT the child's
 *  exit code (`herdr update` exits 0 even when it prints "Herdr was not updated"). */
export interface HerdrUpdateResult {
  ok: boolean;
  from: string | null;
  to: string | null;
  error?: string;
}

export interface HerdrUpdateDeps {
  /** inject point for tests; defaults to running the herdr binary's --version */
  versionRunner?: () => string;
  /** inject point for tests; defaults to fetching herdr.dev/latest.json */
  fetchLatest?: () => Promise<{ version: string; notes?: string }>;
  /**
   * Run the update child, streaming each output line to onLine, resolving when
   * it exits. The AbortSignal fires on watchdog timeout — the default kills the
   * child. Default: spawn `bash -lc <buildUpdateScript>`.
   */
  runUpdate?: (onLine: (line: string) => void, signal: AbortSignal) => Promise<void>;
  /** each log line streamed from the running update; default: no-op */
  onLog?: (line: string) => void;
  /** the recomputed status after the update settles; default: no-op */
  onStatus?: (status: HerdrUpdateStatus) => void;
  /** the terminal result, emitted exactly once per apply(); default: no-op */
  onDone?: (result: HerdrUpdateResult) => void;
  /** maintenance gate; defaults to the shared process singleton */
  maintenance?: { begin(): void; end(): void };
  /** watchdog ceiling before a hung `herdr update` is force-killed (default 5min) */
  watchdogMs?: number;
}

/**
 * Tracks whether a newer herdr (the external terminal multiplexer Shepherd
 * drives) is published upstream and, on demand, drives `herdr update` for the
 * operator. It surfaces a badge keyed off `updateAvailable`.
 *
 * The check parses the installed version from `herdr --version` and compares it
 * against herdr.dev/latest.json. It is fail-safe: any error (binary missing,
 * network down, malformed payload) yields updateAvailable:false, so a broken
 * check can never raise a false badge.
 *
 * `apply()` spawns `herdr server stop; herdr update` as a managed child of
 * shepherd (no systemd-run, no shepherd restart). Shepherd stays up — no 502.
 * Success is determined by re-reading `herdr --version` after the child exits,
 * not by exit code (`herdr update` exits 0 even when it prints "Herdr was not
 * updated"). The terminal result is emitted via onDone.
 */
export class HerdrUpdateService {
  private versionRunner: () => string;
  private fetchLatest: () => Promise<{ version: string; notes?: string }>;
  private runUpdate: (onLine: (line: string) => void, signal: AbortSignal) => Promise<void>;
  private onLog: (line: string) => void;
  private onStatus: (status: HerdrUpdateStatus) => void;
  private onDone: (result: HerdrUpdateResult) => void;
  private maintenance: { begin(): void; end(): void };
  private watchdogMs: number;
  private last: HerdrUpdateStatus | null = null;
  private applying = false;

  constructor(deps: HerdrUpdateDeps = {}) {
    this.versionRunner =
      deps.versionRunner ??
      (() => execFileSync(config.herdrBin, ["--version"], { encoding: "utf8" }));
    this.fetchLatest =
      deps.fetchLatest ??
      (() =>
        fetch(LATEST_URL).then((r) => r.json() as Promise<{ version: string; notes?: string }>));
    this.runUpdate = deps.runUpdate ?? ((onLine, signal) => this.defaultRunUpdate(onLine, signal));
    this.onLog = deps.onLog ?? (() => {});
    this.onStatus = deps.onStatus ?? (() => {});
    this.onDone = deps.onDone ?? (() => {});
    this.maintenance = deps.maintenance ?? sharedMaintenance;
    this.watchdogMs = deps.watchdogMs ?? 5 * 60 * 1000;
  }

  /** Spawn `bash -lc <script>` in shepherd's own process tree (NOT detached —
   *  there is no longer a shepherd restart to outlive), stream stdout+stderr to
   *  onLine, resolve on exit. The signal (watchdog) force-kills a hung child. */
  private defaultRunUpdate(onLine: (line: string) => void, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const script = buildUpdateScript(
        config.herdrUpdateLogPath,
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
        onLine(`herdr update spawn failed: ${err.message}`);
        finish();
      });
    });
  }

  /** Parse the installed version from `herdr --version`; null if unreadable. */
  private installedVersion(): string | null {
    const m = SEMVER_RE.exec(this.versionRunner());
    return m ? m[1]! : null;
  }

  /** Best-effort installed version for the "what are we ACTUALLY on?" report.
   *  Never throws (a missing/exploding `herdr --version` falls back to `fallback`,
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
  current(): HerdrUpdateStatus | null {
    return this.last;
  }

  /** Kick off the update in the background. Returns immediately so the HTTP
   *  endpoint can answer 202; progress streams via onLog and the terminal
   *  outcome via onDone. Guards against a double-launch while one is in flight. */
  apply(): { started: boolean } {
    if (this.applying) return { started: false };
    this.applying = true;
    console.warn(
      `[herdr-update] applying ${this.last?.current ?? "?"} -> ${this.last?.latest ?? "?"}; ` +
        `Shepherd stays up (audit log: ${config.herdrUpdateLogPath})`,
    );
    void this.runOnce();
    return { started: true };
  }

  /** Background body of apply(): run the update under a watchdog, decide success
   *  from a re-read version, emit status + a terminal result, and ALWAYS clear
   *  maintenance + the applying guard in finally. begin() lives INSIDE the try so
   *  its matching end() is guaranteed by the finally even if a prologue step throws
   *  — a stranded maintenance flag would otherwise freeze every herdr loop for the
   *  life of the process. It runs synchronously (before the first await), so the
   *  gate is active the instant apply() returns. */
  private async runOnce(): Promise<void> {
    const from = this.last?.current ?? null;
    const to = this.last?.latest ?? null;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let result: HerdrUpdateResult;
    try {
      this.maintenance.begin();
      const ctrl = new AbortController();
      watchdog = setTimeout(() => ctrl.abort(), this.watchdogMs);
      await this.runUpdate((line) => this.onLog(line), ctrl.signal);
      // Re-read the installed version once: it decides success AND is the version
      // every failure branch reports as "what we're actually on" (never the
      // target, which we know we did not reach).
      const after = this.actualVersion(from);
      if (ctrl.signal.aborted) {
        result = { ok: false, from, to: after, error: "herdr update timed out" };
      } else {
        const ok = !!after && !!to && after === to;
        this.last = {
          current: after,
          latest: to,
          updateAvailable: !!after && !!to && compareSemver(to, after) > 0,
          notes: null,
          checkedAt: Date.now(),
          error: ok ? undefined : "herdr was not updated",
        };
        this.onStatus(this.last);
        result = ok
          ? { ok: true, from, to }
          : { ok: false, from, to: after, error: "herdr was not updated" };
      }
    } catch (err) {
      // runUpdate itself threw (e.g. spawn failed) — re-read the actual version
      // so we don't claim the target either.
      result = {
        ok: false,
        from,
        to: this.actualVersion(from),
        error: err instanceof Error ? err.message : "herdr update failed",
      };
    } finally {
      clearTimeout(watchdog);
      this.maintenance.end();
      this.applying = false;
    }
    this.onDone(result);
  }

  /** Re-read the installed herdr version and the latest published one, then
   *  compare. On any failure returns updateAvailable:false with an error set. */
  async check(now: number): Promise<HerdrUpdateStatus> {
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
        notes: updateAvailable ? (latestRaw.notes ?? null) : null,
        checkedAt: now,
      };
    } catch (e) {
      this.last = {
        current: this.last?.current ?? null,
        latest: null,
        updateAvailable: false,
        notes: null,
        checkedAt: now,
        error: e instanceof Error ? e.message : "herdr update check failed",
      };
    }
    return this.last;
  }
}
