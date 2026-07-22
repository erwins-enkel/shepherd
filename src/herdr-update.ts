import { spawn } from "node:child_process";
import { execFileSync } from "./instrument";
import { config } from "./config";
import {
  HERDR_LAST_SUPPORTED_VERSION,
  isHerdrVersionSupported,
  setDetectedHerdrVersion,
} from "./herdr-capabilities";
import { maintenance as sharedMaintenance } from "./maintenance";
import { compareSemver } from "./semver";
import type { HerdrUpdateStatus } from "./types";

export type { HerdrUpdateStatus };
// Re-exported so existing importers (diagnostics, plugin-update, codex-update) keep their
// `from "./herdr-update"` path; the implementation now lives in the leaf semver.ts (so
// herdr-capabilities.ts can share it without an import cycle).
export { compareSemver };

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
  herdrBin: string = config.herdrBin,
): string {
  const f = sanitizeVersion(from);
  const t = sanitizeVersion(to);
  // single-quote for the shell; a literal `'` inside (vanishingly unlikely in a
  // home path or binary path) is escaped via the classic '\'' close-reopen trick.
  const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
  const q = shq(logPath);
  // The configured herdr binary (HERDR_BIN / config.herdrBin), shell-quoted so a
  // custom install path can't break the script. Every herdr invocation below uses
  // it — a bare `herdr` would miss on a custom-binary host (mirrors restart.ts).
  const h = shq(herdrBin);
  // Shepherd stays up during the update (no restart), so it captures this
  // script's stdout live for the modal. The `tee -a` is kept anyway: it makes
  // `cat <logPath>` a durable post-mortem that survives even a shepherd crash.
  // `--handoff` is required because Shepherd itself runs as a live herdr target.
  // A protocol-bumping update (e.g. 0.6.5 proto 11 → 0.6.8 proto 12) refuses to
  // proceed while targets are running: bare `herdr update` aborts with "one or
  // more herdr targets must restart". `--handoff` hands the running targets to
  // the new version instead of aborting. We deliberately do NOT `herdr server
  // stop` first: that earlier mitigation never cleared the targets (they OUTLIVE
  // the server) yet left the server dead, so a failed update orphaned every agent
  // pane. Not stopping means a failed update usually leaves the live server +
  // panes untouched.
  //
  // Recovery (#1558): `herdr update` exits 0 even when it leaves NO running server, so
  // gating recovery on `rc != 0` (as we used to) skipped the exact bug. So we ALWAYS run
  // `herdr agent list` after the update, regardless of rc.
  //
  // That call VERIFIES; it does not repair. An earlier version of this comment claimed any
  // herdr CLI call auto-spawns the daemon (sourced to the 0.6.x-era "herdr update without a
  // shepherd restart" design doc). That is FALSE on 0.7.x: against a dead socket `herdr
  // agent list` exits 1 with ENOENT and spawns nothing — verified in a clean instance
  // (#1574). The `setsid … server` fallback below is therefore NOT a belt-and-braces
  // leftover; it is the ONLY thing that recovers a host whose server did not come back.
  //
  // Grace + retry: a still-binding server — an in-flight `--handoff`, or a self-
  // managed systemd unit with `Restart=always` coming up — must not be mistaken for
  // "down". The retry loop lets it bind first, so a systemd-managed server wins and
  // the fallback below is never entered.
  //
  // Last-resort fallback: the ONLY repair path (see above — nothing auto-spawns). Relaunch a
  // detached server so orphaned targets reattach. On a host provisioned by deploy/provision.ts
  // this is normally unreachable: `deploy/herdr.service` (Restart=always) wins the retry race
  // above. It still covers hand-rolled installs with no unit.
  return [
    `LOG=${q}`,
    'mkdir -p "$(dirname "$LOG")"',
    "{",
    `  echo "=== herdr-update $(date -u +%Y-%m-%dT%H:%M:%SZ) ${f} -> ${t} ==="`,
    `  echo '${UPDATE_LOG_PREFIX} running herdr update --handoff'`,
    `  ${h} update --handoff; rc=$?`,
    `  echo "${UPDATE_LOG_PREFIX} herdr update exited rc=$rc"`,
    // Unconditional (NOT gated on rc): `herdr update` can exit 0 having left NO running
    // server (#1558), so this call VERIFIES reachability on every path. It does not repair —
    // nothing auto-spawns (#1574); the fallback below is the only repair. Grace+retry lets an
    // in-flight --handoff or a systemd `Restart=always` unit bind first before we conclude
    // "unreachable".
    "  ok=0",
    "  for attempt in 1 2 3; do",
    `    if timeout 10 ${h} agent list >/dev/null 2>&1; then ok=1; break; fi`,
    "    sleep 2",
    "  done",
    '  if [ "$ok" -eq 1 ]; then',
    `    echo '${UPDATE_LOG_PREFIX} herdr server reachable after update'`,
    "  else",
    `    echo '${UPDATE_LOG_PREFIX} herdr server unreachable after retries — relaunching a detached server so orphaned sessions reattach'`,
    `    setsid ${h} server </dev/null >/dev/null 2>&1 &`,
    "  fi",
    '} 2>&1 | tee -a "$LOG"',
  ].join("\n");
}

/** Map this host onto latest.json's asset key (`linux-x86_64`, `macos-aarch64`, …);
 *  null when herdr publishes no binary for the platform. */
export function herdrAssetKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const os = platform === "linux" ? "linux" : platform === "darwin" ? "macos" : null;
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  return os && cpu ? `${os}-${cpu}` : null;
}

/** The version-addressable release-asset URL, built from a HARDCODED template (the
 *  same GitHub slug the modal's release-notes link uses). The downgrade flow (#1898)
 *  cross-checks this against latest.json's `releases` map before running — the
 *  template guarantees shape (no injection), the manifest guarantees currency. */
export function herdrReleaseUrl(version: string, assetKey: string): string {
  return `https://github.com/ogulcancelik/herdr/releases/download/v${sanitizeVersion(version)}/herdr-${assetKey}`;
}

/**
 * The shell program for the in-app DOWNGRADE to a supported herdr (#1898). Same
 * logging contract as buildUpdateScript (one delimited `tee -a` block, every step
 * announced with UPDATE_LOG_PREFIX, explicit exit codes).
 *
 * Safety-critical ordering: download → verify → atomic swap → THEN restart. Every
 * failure before the swap aborts with the old binary untouched and the old server
 * still running — a failed rescue leaves the install exactly as broken as it was,
 * never more broken. No `--handoff`: on a stranded install the #1887 guard refused
 * every spawn, so there are no live agent panes to preserve.
 */
export function buildDowngradeScript(
  logPath: string,
  from: string | null | undefined,
  to: string | null | undefined,
  url: string,
  herdrBin: string = config.herdrBin,
): string {
  const f = sanitizeVersion(from);
  const t = sanitizeVersion(to);
  const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
  const q = shq(logPath);
  const h = shq(herdrBin);
  const u = shq(url);
  return [
    `LOG=${q}`,
    'mkdir -p "$(dirname "$LOG")"',
    "{",
    `  echo "=== herdr-downgrade $(date -u +%Y-%m-%dT%H:%M:%SZ) ${f} -> ${t} ==="`,
    // Resolve the real path first: config.herdrBin may be a bare "herdr" found via
    // PATH, and the atomic swap below must target the actual file, not ./herdr.
    `  BIN="$(command -v ${h} || true)"`,
    '  if [ -z "$BIN" ]; then',
    `    echo '${UPDATE_LOG_PREFIX} cannot locate the herdr binary — aborting'`,
    "    exit 1",
    "  fi",
    // Temp file NEXT TO the binary (same filesystem) so the swap is an atomic rename.
    '  TMP="$BIN.downgrade.$$"',
    `  echo '${UPDATE_LOG_PREFIX} downloading herdr ${t}'`,
    `  if ! curl -fsSL --retry 3 --connect-timeout 10 --max-time 120 -o "$TMP" ${u}; then`,
    `    echo '${UPDATE_LOG_PREFIX} download failed — herdr binary untouched'`,
    '    rm -f "$TMP"',
    "    exit 1",
    "  fi",
    '  chmod +x "$TMP"',
    `  echo '${UPDATE_LOG_PREFIX} verifying downloaded binary reports ${t}'`,
    // Exact match, not substring: a `grep -qF` here would let "10.7.4" or "0.7.40"
    // pass verification against a "0.7.4" target. Extract the first semver token
    // (mirrors the server-side SEMVER_RE parse of `herdr --version`) and compare
    // it for equality.
    `  V="$("$TMP" --version 2>/dev/null | grep -oE "[0-9]+\\.[0-9]+\\.[0-9]+" | head -n 1)"`,
    `  if [ "$V" != "${t}" ]; then`,
    `    echo '${UPDATE_LOG_PREFIX} downloaded binary does not report ${t} — aborting, herdr binary untouched'`,
    '    rm -f "$TMP"',
    "    exit 1",
    "  fi",
    `  echo '${UPDATE_LOG_PREFIX} swapping the verified binary into place'`,
    '  if ! mv -f "$TMP" "$BIN"; then',
    `    echo '${UPDATE_LOG_PREFIX} swap failed — herdr binary untouched'`,
    '    rm -f "$TMP"',
    "    exit 1",
    "  fi",
    // Only AFTER the verified swap is the running server touched. `server stop`
    // suffices on provisioned hosts (deploy/herdr.service has Restart=always); the
    // grace+retry loop lets systemd win before the last-resort detached relaunch —
    // the same recovery pattern as buildUpdateScript.
    `  echo '${UPDATE_LOG_PREFIX} stopping the herdr server so it relaunches on the downgraded binary'`,
    '  "$BIN" server stop; rc=$?',
    `  echo "${UPDATE_LOG_PREFIX} herdr server stop exited rc=$rc"`,
    "  ok=0",
    "  for attempt in 1 2 3; do",
    '    if timeout 10 "$BIN" agent list >/dev/null 2>&1; then ok=1; break; fi',
    "    sleep 2",
    "  done",
    '  if [ "$ok" -eq 1 ]; then',
    `    echo '${UPDATE_LOG_PREFIX} herdr server reachable after downgrade'`,
    "  else",
    `    echo '${UPDATE_LOG_PREFIX} herdr server unreachable after retries — relaunching a detached server'`,
    '    setsid "$BIN" server </dev/null >/dev/null 2>&1 &',
    "  fi",
    '} 2>&1 | tee -a "$LOG"',
  ].join("\n");
}

/** Status fields derived from the INSTALLED version's support policy (#1898). A
 *  stranded install (unsupported current, e.g. 0.7.5+) advertises the version the
 *  in-app downgrade would install, so the UI never hardcodes a version. */
function supportFlags(
  current: string | null,
): Pick<HerdrUpdateStatus, "currentUnsupported" | "downgradeTarget"> {
  const unsupported = !isHerdrVersionSupported(current);
  return {
    currentUnsupported: unsupported,
    downgradeTarget: unsupported ? HERDR_LAST_SUPPORTED_VERSION : null,
  };
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

/** Subset of herdr.dev/latest.json Shepherd reads: the latest release (version/notes)
 *  plus the per-version `releases` map used to resolve versioned artifacts (#1898). */
export interface HerdrManifest {
  version: string;
  notes?: string;
  releases?: Record<string, { assets?: Record<string, string> }>;
}

export interface HerdrUpdateDeps {
  /** inject point for tests; defaults to running the herdr binary's --version */
  versionRunner?: () => string;
  /** inject point for tests; defaults to fetching herdr.dev/latest.json */
  fetchLatest?: () => Promise<HerdrManifest>;
  /**
   * Run the update child, streaming each output line to onLine, resolving when
   * it exits. The AbortSignal fires on watchdog timeout — the default kills the
   * child. Default: spawn `bash -lc <buildUpdateScript>`.
   */
  runUpdate?: (onLine: (line: string) => void, signal: AbortSignal) => Promise<void>;
  /**
   * Run the downgrade child for the given script, streaming output to onLine,
   * resolving on exit (#1898). Same watchdog semantics as runUpdate. Default:
   * spawn `bash -lc <script>`.
   */
  runDowngrade?: (
    script: string,
    onLine: (line: string) => void,
    signal: AbortSignal,
  ) => Promise<void>;
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
 * `apply()` spawns `herdr update --handoff` as a managed child of shepherd (no
 * systemd-run, no shepherd restart). Shepherd stays up — no 502.
 * Success is determined by re-reading `herdr --version` after the child exits,
 * not by exit code (`herdr update` exits 0 even when it prints "Herdr was not
 * updated"). The terminal result is emitted via onDone.
 */
export class HerdrUpdateService {
  private versionRunner: () => string;
  private fetchLatest: () => Promise<HerdrManifest>;
  private runUpdate: (onLine: (line: string) => void, signal: AbortSignal) => Promise<void>;
  private runDowngrade: (
    script: string,
    onLine: (line: string) => void,
    signal: AbortSignal,
  ) => Promise<void>;
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
      deps.fetchLatest ?? (() => fetch(LATEST_URL).then((r) => r.json() as Promise<HerdrManifest>));
    this.runUpdate = deps.runUpdate ?? ((onLine, signal) => this.defaultRunUpdate(onLine, signal));
    this.runDowngrade =
      deps.runDowngrade ?? ((script, onLine, signal) => this.spawnScript(script, onLine, signal));
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
    const script = buildUpdateScript(
      config.herdrUpdateLogPath,
      this.last?.current,
      this.last?.latest,
    );
    return this.spawnScript(script, onLine, signal);
  }

  private spawnScript(
    script: string,
    onLine: (line: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve) => {
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
    // Never upgrade INTO an unsupported herdr from inside Shepherd: 0.7.5+ broke agent spawning
    // (#1889), so applying it would leave the operator unable to spawn. The modal also warns +
    // hides the run button; this is the server-side backstop against a direct POST.
    if (this.last?.latestUnsupported) {
      console.warn(
        `[herdr-update] refusing in-app upgrade to unsupported herdr ${this.last?.latest ?? "?"} ` +
          `— pin to 0.7.4 (see #1889)`,
      );
      return { started: false };
    }
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
      // `herdr update` swaps the running binary, so refresh the detected version the driver's
      // spawn guard reads (keeps the ceiling accurate without a Shepherd restart).
      setDetectedHerdrVersion(after);
      if (ctrl.signal.aborted) {
        result = { ok: false, from, to: after, error: "herdr update timed out" };
      } else {
        const ok = !!after && !!to && after === to;
        this.last = {
          current: after,
          latest: to,
          updateAvailable: !!after && !!to && compareSemver(to, after) > 0,
          latestUnsupported: !isHerdrVersionSupported(to),
          ...supportFlags(after),
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

  /** Resolve the versioned artifact URL for `target`: the hardcoded template AND the
   *  manifest's releases entry must agree (user-chosen trust model, #1898). Throws a
   *  human-readable error on any mismatch — surfaced via onDone into the modal. */
  private async resolveDowngradeUrl(target: string): Promise<string> {
    const assetKey = herdrAssetKey();
    if (!assetKey) {
      throw new Error(`no herdr binary published for ${process.platform}/${process.arch}`);
    }
    const templateUrl = herdrReleaseUrl(target, assetKey);
    const manifest = await this.fetchLatest();
    const manifestUrl = manifest?.releases?.[target]?.assets?.[assetKey];
    if (!manifestUrl) {
      throw new Error(`herdr.dev manifest has no ${target} asset for ${assetKey}`);
    }
    if (manifestUrl !== templateUrl) {
      throw new Error(
        `refusing downgrade: manifest URL ${manifestUrl} does not match the expected ${templateUrl}`,
      );
    }
    return templateUrl;
  }

  /** Kick off the in-app downgrade to HERDR_LAST_SUPPORTED_VERSION in the background
   *  (#1898). Mirrors apply(): returns immediately for a 202, streams progress via
   *  onLog, terminal outcome via onDone. Refuses when the installed version is
   *  already supported (nothing to rescue) or while a run is in flight. */
  downgrade(): { started: boolean } {
    if (this.applying) return { started: false };
    const current = this.last?.current ?? null;
    if (isHerdrVersionSupported(current)) {
      console.warn(
        `[herdr-update] refusing downgrade: installed herdr ${current ?? "?"} is already supported`,
      );
      return { started: false };
    }
    this.applying = true;
    console.warn(
      `[herdr-update] downgrading ${current} -> ${HERDR_LAST_SUPPORTED_VERSION}; ` +
        `Shepherd stays up (audit log: ${config.herdrUpdateLogPath})`,
    );
    void this.runDowngradeOnce(current);
    return { started: true };
  }

  /** Background body of downgrade(): resolve+cross-check the artifact URL, run the
   *  script under the watchdog, decide success from a re-read version, refresh the
   *  spawn guard, and ALWAYS clear maintenance + the applying guard (same contract
   *  as runOnce — begin() inside the try, matching end() in finally). */
  private async runDowngradeOnce(from: string | null): Promise<void> {
    const to = HERDR_LAST_SUPPORTED_VERSION;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let result: HerdrUpdateResult;
    try {
      this.maintenance.begin();
      const url = await this.resolveDowngradeUrl(to);
      const script = buildDowngradeScript(config.herdrUpdateLogPath, from, to, url);
      const ctrl = new AbortController();
      watchdog = setTimeout(() => ctrl.abort(), this.watchdogMs);
      await this.runDowngrade(script, (line) => this.onLog(line), ctrl.signal);
      const after = this.actualVersion(from);
      // the script swapped the binary — refresh the ceiling the spawn guard reads
      setDetectedHerdrVersion(after);
      if (ctrl.signal.aborted) {
        result = { ok: false, from, to: after, error: "herdr downgrade timed out" };
      } else {
        const ok = !!after && after === to;
        const latest = this.last?.latest ?? null;
        const updateAvailable = !!after && !!latest && compareSemver(latest, after) > 0;
        this.last = {
          current: after,
          latest,
          updateAvailable,
          latestUnsupported: updateAvailable && !isHerdrVersionSupported(latest),
          ...supportFlags(after),
          notes: this.last?.notes ?? null,
          checkedAt: Date.now(),
          error: ok ? undefined : "herdr was not downgraded",
        };
        this.onStatus(this.last);
        result = ok
          ? { ok: true, from, to }
          : { ok: false, from, to: after, error: "herdr was not downgraded" };
      }
    } catch (err) {
      // URL resolution / cross-check / spawn failed — the binary was never touched;
      // report what we're actually on (never the target).
      result = {
        ok: false,
        from,
        to: this.actualVersion(from),
        error: err instanceof Error ? err.message : "herdr downgrade failed",
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
      // Keep the driver's spawn guard in sync with what's actually installed (catches an
      // out-of-band `herdr update` between boot and this periodic check).
      setDetectedHerdrVersion(current);

      const latestRaw = await this.fetchLatest();
      const latestMatch = latestRaw?.version ? SEMVER_RE.exec(latestRaw.version) : null;
      const latest = latestMatch ? latestMatch[1]! : null;

      const updateAvailable = !!current && !!latest && compareSemver(latest, current) > 0;
      // A newer-but-unsupported latest (0.7.5+) still shows the badge/modal, but the modal warns
      // and the updater refuses it — see apply() + HerdrUpdateModal. #1889.
      const latestUnsupported = updateAvailable && !isHerdrVersionSupported(latest);

      this.last = {
        current,
        latest,
        updateAvailable,
        latestUnsupported,
        ...supportFlags(current),
        notes: updateAvailable ? (latestRaw.notes ?? null) : null,
        checkedAt: now,
      };
    } catch (e) {
      this.last = {
        current: this.last?.current ?? null,
        latest: null,
        updateAvailable: false,
        ...supportFlags(this.last?.current ?? null),
        notes: null,
        checkedAt: now,
        error: e instanceof Error ? e.message : "herdr update check failed",
      };
    }
    return this.last;
  }
}
