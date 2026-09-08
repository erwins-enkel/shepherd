import { execFileSync } from "./instrument";
import { config } from "./config";
import {
  HERDR_LAST_FULL_SANDBOX_STATUS_VERSION,
  HERDR_LAST_SUPPORTED_VERSION,
  herdrUsesExternalRegistrationSpawn,
  isHerdrVersionSupported,
  setDetectedHerdrVersion,
} from "./herdr-capabilities";
import { maintenance as sharedMaintenance } from "./maintenance";
import { compareSemver } from "./semver";
import { herdrAssetKey, herdrReleaseUrl, sanitizeVersion } from "./herdr-install";
import { runScriptChild } from "./script-child";
import { readInstalledVersion, readActualVersion } from "./version-probe";
import type { HerdrUpdateStatus, HerdrUpdateResult } from "./types";
import { probeHerdrRuntime, type HerdrRuntimeStatus } from "./herdr-runtime";
import { runHerdrRecovery } from "./herdr-recovery";

export type { HerdrUpdateStatus, HerdrUpdateResult };
// Re-exported so existing importers (diagnostics, plugin-update, codex-update) keep their
// `from "./herdr-update"` path; the implementation now lives in the leaf semver.ts (so
// herdr-capabilities.ts can share it without an import cycle).
export { compareSemver };
// Same pattern for the release-artifact helpers: they moved to the leaf herdr-install.ts (so
// preflight.ts can build a pinned install line without pulling config.ts into the boot path),
// and are re-exported here for existing importers + test/herdr-downgrade.test.ts.
export { herdrAssetKey, herdrReleaseUrl };

const SEMVER_RE = /(\d+\.\d+\.\d+)/;
const LATEST_URL = "https://herdr.dev/latest.json";

/** Prefix every step marker the update script echoes. Stable + greppable so the
 *  operator can `cat ~/.shepherd/herdr-update.log | grep '>>> herdr-update'` and
 *  read the exact sequence (and exit code) even after shepherd has restarted. */
export const UPDATE_LOG_PREFIX = ">>> herdr-update:";

// single-quote for the shell; a literal `'` inside (vanishingly unlikely in a
// home path or binary path) is escaped via the classic '\'' close-reopen trick.
const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

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
  // A failed handoff can leave a LIVE older server behind. Runtime verification and
  // offline-only recovery belong to the service, which can distinguish that from a
  // missing daemon. Never launch another server solely because agent list failed.
  return [
    `LOG=${q}`,
    'mkdir -p "$(dirname "$LOG")"',
    "{",
    `  echo "=== herdr-update $(date -u +%Y-%m-%dT%H:%M:%SZ) ${f} -> ${t} ==="`,
    `  echo '${UPDATE_LOG_PREFIX} running herdr update --handoff'`,
    `  ${h} update --handoff; rc=$?`,
    `  echo "${UPDATE_LOG_PREFIX} herdr update exited rc=$rc"`,
    '} 2>&1 | tee -a "$LOG"',
  ].join("\n");
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

/** Status fields for the sandboxed-idle advisory (herdr #1716, two-path). Set only when the
 *  installed herdr uses the external-registration spawn path (0.7.5+, where a sandboxed agent's
 *  idle can't be reported) AND this operator runs sandboxed sessions. Reads the process-wide
 *  detected version via {@link herdrUsesExternalRegistrationSpawn} — check() calls
 *  setDetectedHerdrVersion first, so it reflects what's installed. */
function sandboxFlags(
  sandboxedInUse: boolean,
): Pick<HerdrUpdateStatus, "sandboxIdleRegressed" | "sandboxDowngradeTarget"> {
  const regressed = herdrUsesExternalRegistrationSpawn() && sandboxedInUse;
  return {
    sandboxIdleRegressed: regressed,
    sandboxDowngradeTarget: regressed ? HERDR_LAST_FULL_SANDBOX_STATUS_VERSION : null,
  };
}

/** Subset of herdr.dev/latest.json Shepherd reads: the latest release (version/notes)
 *  plus the per-version `releases` map used to resolve versioned artifacts (#1898). */
export interface HerdrManifest {
  version: string;
  notes?: string;
  releases?: Record<string, { assets?: Record<string, string> }>;
}

export interface HerdrUpdateDeps {
  probeRuntime?: (signal?: AbortSignal) => Promise<HerdrRuntimeStatus>;
  runRecovery?: (
    restart: boolean,
    signal: AbortSignal,
    expected: HerdrRuntimeStatus,
  ) => Promise<void>;
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
  maintenance?: { readonly active?: boolean; begin(): void; end(): void };
  /** watchdog ceiling before a hung `herdr update` is force-killed (default 5min) */
  watchdogMs?: number;
  /** Whether this operator runs sandboxed sessions — gates the sandboxed-idle advisory (#1716) so
   *  it never shows to a trusted-only operator (who has no regression). Default: `() => false`
   *  (conservative: no advisory unless wired). */
  sandboxedInUse?: () => boolean;
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
 * Updates succeed only when the installed target matches the running server and
 * agent calls work. A successful binary install alone leaves a repairable state.
 * The terminal result is emitted via onDone.
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
  private maintenance: { readonly active?: boolean; begin(): void; end(): void };
  private watchdogMs: number;
  private sandboxedInUse: () => boolean;
  private last: HerdrUpdateStatus | null = null;
  private applying = false;
  private runtime?: HerdrRuntimeStatus;
  private phase: NonNullable<HerdrUpdateStatus["phase"]> = "idle";
  private result: HerdrUpdateResult | null = null;
  private operation?: { from: string | null; to: string | null };
  private revision = Date.now();
  private runtimeRead: Promise<HerdrUpdateStatus> | null = null;
  private probeRuntime: (signal?: AbortSignal) => Promise<HerdrRuntimeStatus>;
  private runRecovery: (
    restart: boolean,
    signal: AbortSignal,
    expected: HerdrRuntimeStatus,
  ) => Promise<void>;

  constructor(deps: HerdrUpdateDeps = {}) {
    this.probeRuntime = deps.probeRuntime ?? ((signal) => probeHerdrRuntime({ signal }));
    this.runRecovery =
      deps.runRecovery ??
      ((restart, signal, expected) =>
        runHerdrRecovery({ restart, signal, expected, logPath: config.herdrUpdateLogPath }));
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
    this.sandboxedInUse = deps.sandboxedInUse ?? (() => false);
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
    return runScriptChild(script, onLine, signal, "herdr update");
  }

  /** Parse the installed version from `herdr --version`; null if unreadable. */
  private installedVersion(): string | null {
    return readInstalledVersion(this.versionRunner, SEMVER_RE);
  }

  /** Best-effort installed version for the "what are we ACTUALLY on?" report.
   *  Never throws (a missing/exploding `herdr --version` falls back to `fallback`,
   *  the last-known-good). Used by every failure branch so we never tell the
   *  operator they're on the target version we know they did NOT reach. */
  private actualVersion(fallback: string | null): string | null {
    return readActualVersion(this.versionRunner, SEMVER_RE, fallback);
  }

  /** Last computed status, or null before the first check. */
  current(): HerdrUpdateStatus | null {
    return this.last
      ? {
          ...this.last,
          runtime: this.runtime,
          phase: this.phase,
          operation: this.operation,
          result: this.result,
          revision: this.revision,
        }
      : null;
  }

  private publish(): void {
    this.revision++;
    const status = this.current();
    if (status) this.onStatus(status);
  }

  private recordRuntime(runtime: HerdrRuntimeStatus): void {
    this.runtime = runtime;
    this.last = {
      latest: null,
      notes: null,
      checkedAt: Date.now(),
      ...this.last,
      current: runtime.installedVersion,
      updateAvailable:
        !!runtime.installedVersion &&
        !!this.last?.latest &&
        compareSemver(this.last.latest, runtime.installedVersion) > 0,
      ...supportFlags(runtime.installedVersion),
    };
  }

  /** Refresh local facts without depending on the release service. Coalesce open dialogs. */
  async status(): Promise<HerdrUpdateStatus> {
    this.last ??= {
      current: null,
      latest: null,
      updateAvailable: false,
      notes: null,
      checkedAt: Date.now(),
    };
    if (this.applying) return this.current()!;
    if (this.runtimeRead) return this.runtimeRead;
    const revision = this.revision;
    this.runtimeRead = (async () => {
      const runtime = await this.probeRuntime();
      if (!this.applying && revision === this.revision) {
        this.recordRuntime(runtime);
        if (
          runtime.state === "ready" &&
          runtime.serverVersion === runtime.installedVersion &&
          this.result?.errorCode === "restart_required"
        )
          this.result = null;
        this.publish();
      }
      return this.current()!;
    })().finally(() => {
      this.runtimeRead = null;
    });
    return this.runtimeRead;
  }

  /** Re-read the installed version after the child ran (it decides success and is what
   *  every failure branch reports) and refresh the spawn guard's ceiling. */
  private settleAfterScript(from: string | null): string | null {
    const after = this.actualVersion(from);
    setDetectedHerdrVersion(after);
    return after;
  }

  /** Kick off the update in the background. Returns immediately so the HTTP
   *  endpoint can answer 202; progress streams via onLog and the terminal
   *  outcome via onDone. Guards against a double-launch while one is in flight. */
  apply(): { started: boolean } {
    if (this.applying || this.maintenance.active) return { started: false };
    // Never upgrade INTO an unsupported herdr from inside Shepherd: a herdr newer than Shepherd
    // supports can't spawn agents, so applying it would leave the operator unable to spawn. The
    // modal also warns + hides the run button; this is the server-side backstop against a direct POST.
    if (this.last?.latestUnsupported) {
      console.warn(
        `[herdr-update] refusing in-app upgrade to unsupported herdr ${this.last?.latest ?? "?"} ` +
          `— newer than Shepherd supports`,
      );
      return { started: false };
    }
    this.applying = true;
    this.operation = { from: this.last?.current ?? null, to: this.last?.latest ?? null };
    this.phase = "updating";
    this.result = null;
    this.publish();
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
    const ctrl = new AbortController();
    const watchdog = setTimeout(() => ctrl.abort(), this.watchdogMs);
    let result: HerdrUpdateResult;
    let handoffPaneLimit: number | undefined;
    try {
      this.maintenance.begin();
      await this.runUpdate((line) => {
        const limit = /live handoff supports at most (\d+) panes/.exec(line);
        if (limit) handoffPaneLimit = Number(limit[1]);
        this.onLog(line);
      }, ctrl.signal);
      const after = this.settleAfterScript(from);
      this.phase = "verifying";
      this.publish();
      this.runtime = await this.probeRuntime(ctrl.signal);
      if (!ctrl.signal.aborted && this.runtime.state === "offline") {
        await this.runRecovery(false, ctrl.signal, this.runtime);
        this.runtime = await this.probeRuntime(ctrl.signal);
      }
      result = this.verifiedResult(from, to, after, ctrl.signal);
      if (handoffPaneLimit && result.errorCode === "restart_required")
        result.handoffPaneLimit = handoffPaneLimit;
    } catch (err) {
      result = {
        ok: false,
        from,
        to: this.actualVersion(from),
        errorCode: ctrl.signal.aborted ? "timeout" : "update_failed",
        error: err instanceof Error ? err.message : "herdr update failed",
      };
    } finally {
      clearTimeout(watchdog);
      this.maintenance.end();
      this.applying = false;
      this.phase = "idle";
    }
    this.finish(result);
  }

  private verifiedResult(
    from: string | null,
    target: string | null,
    installed: string | null,
    signal: AbortSignal,
  ): HerdrUpdateResult {
    const runtime = this.runtime;
    const ok =
      !signal.aborted &&
      !!target &&
      installed === target &&
      runtime?.state === "ready" &&
      runtime.installedVersion === target &&
      runtime.serverVersion === target;
    const errorCode = signal.aborted
      ? "timeout"
      : runtime?.state === "restart_required"
        ? "restart_required"
        : runtime?.state === "offline"
          ? "offline"
          : installed !== target
            ? "update_failed"
            : "probe_failed";
    return {
      ok,
      from,
      to: installed,
      serverVersion: runtime?.serverVersion ?? null,
      ...(ok ? {} : { errorCode }),
    };
  }

  private finish(result: HerdrUpdateResult): void {
    this.result = result;
    if (this.last)
      this.last = {
        ...this.last,
        current: result.to,
        updateAvailable:
          !!result.to && !!this.last.latest && compareSemver(this.last.latest, result.to) > 0,
        ...supportFlags(result.to),
      };
    this.publish();
    this.onDone(result);
  }

  /** Reserve the shared operation guard before checking the confirmed snapshot. */
  async restartServer(expected: {
    installedVersion: string | null;
    serverVersion: string | null;
  }): Promise<{ started: boolean; error?: string }> {
    if (this.applying || this.maintenance.active) return { started: false, error: "in_progress" };
    this.applying = true;
    try {
      this.maintenance.begin();
      const runtime = await this.probeRuntime();
      this.recordRuntime(runtime);
      if (
        !runtime.installedVersion ||
        !isHerdrVersionSupported(runtime.installedVersion) ||
        runtime.state === "unknown"
      ) {
        this.maintenance.end();
        this.applying = false;
        this.publish();
        return { started: false, error: "runtime_unavailable" };
      }
      if (runtime.state === "ready" && runtime.serverVersion === runtime.installedVersion) {
        this.finish({
          ok: true,
          from: runtime.serverVersion,
          to: runtime.installedVersion,
          serverVersion: runtime.serverVersion,
        });
        this.maintenance.end();
        this.applying = false;
        return { started: true };
      }
      if (
        expected.installedVersion !== runtime.installedVersion ||
        expected.serverVersion !== runtime.serverVersion
      ) {
        this.maintenance.end();
        this.applying = false;
        this.publish();
        return { started: false, error: "runtime_changed" };
      }
      this.operation = { from: runtime.serverVersion, to: runtime.installedVersion };
      this.phase = "restarting";
      this.result = null;
      this.publish();
      void this.runRestart(runtime);
      return { started: true };
    } catch (err) {
      this.maintenance.end();
      this.applying = false;
      this.publish();
      return { started: false, error: err instanceof Error ? err.message : "probe_failed" };
    }
  }

  private async runRestart(before: HerdrRuntimeStatus): Promise<void> {
    const ctrl = new AbortController();
    const watchdog = setTimeout(() => ctrl.abort(), this.watchdogMs);
    let result: HerdrUpdateResult;
    try {
      await this.runRecovery(before.state !== "offline", ctrl.signal, before);
      this.phase = "verifying";
      this.publish();
      this.runtime = await this.probeRuntime(ctrl.signal);
      result = this.verifiedResult(
        before.serverVersion,
        before.installedVersion,
        this.runtime.installedVersion,
        ctrl.signal,
      );
    } catch (err) {
      // The worker may have stopped the old daemon before failing. Never retain stale facts.
      this.runtime = await this.probeRuntime().catch(() => ({
        state: "unknown" as const,
        installedVersion: before.installedVersion,
        serverVersion: null,
        reason: "probe_failed" as const,
      }));
      result = {
        ok: false,
        from: before.serverVersion,
        to: this.runtime.installedVersion,
        serverVersion: this.runtime.serverVersion,
        errorCode: ctrl.signal.aborted ? "timeout" : "restart_failed",
        error: err instanceof Error ? err.message : "herdr restart failed",
      };
    } finally {
      clearTimeout(watchdog);
      this.maintenance.end();
      this.applying = false;
      this.phase = "idle";
    }
    this.finish(result);
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
  downgrade(target: string = HERDR_LAST_SUPPORTED_VERSION): { started: boolean } {
    if (this.applying || this.maintenance.active) return { started: false };
    // Re-read the ACTUAL installed version rather than trusting `this.last.current`
    // (the periodic check(), up to 6h stale): if the operator manually pinned lower
    // out-of-band since the last check, gating on the stale cache would still pass
    // and restart the herdr server for nothing. actualVersion() is best-effort and
    // never throws.
    const current = this.actualVersion(this.last?.current ?? null);
    // Refuse when there's nothing to move: the installed version is already at or below the target.
    // For the stranded rescue (target = supported ceiling) this is exactly "already supported"; for
    // the two-path sandbox escape (target = last full-sandbox-status version) it allows the step
    // down from a supported-but-regressed 0.7.5+. A null/unreadable version refuses (can't verify).
    if (!current || compareSemver(current, target) <= 0) {
      console.warn(
        `[herdr-update] refusing downgrade: installed herdr ${current ?? "?"} is already <= ${target}`,
      );
      return { started: false };
    }
    this.applying = true;
    this.runtime = undefined;
    this.operation = { from: current, to: target };
    this.phase = "updating";
    this.result = null;
    this.publish();
    console.warn(
      `[herdr-update] downgrading ${current} -> ${target}; ` +
        `Shepherd stays up (audit log: ${config.herdrUpdateLogPath})`,
    );
    void this.runDowngradeOnce(current, target);
    return { started: true };
  }

  /** Background body of downgrade(): resolve+cross-check the artifact URL, run the
   *  script under the watchdog, decide success from a re-read version, refresh the
   *  spawn guard, and ALWAYS clear maintenance + the applying guard (same contract
   *  as runOnce — begin() inside the try, matching end() in finally). */
  private async runDowngradeOnce(from: string | null, to: string): Promise<void> {
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let result: HerdrUpdateResult;
    try {
      this.maintenance.begin();
      const url = await this.resolveDowngradeUrl(to);
      const script = buildDowngradeScript(config.herdrUpdateLogPath, from, to, url);
      const ctrl = new AbortController();
      watchdog = setTimeout(() => ctrl.abort(), this.watchdogMs);
      await this.runDowngrade(script, (line) => this.onLog(line), ctrl.signal);
      // the script swapped the binary — refresh the ceiling the spawn guard reads
      const installed = this.settleAfterScript(from);
      if (ctrl.signal.aborted) {
        result = { ok: false, from, to: installed, error: "herdr downgrade timed out" };
      } else {
        const ok = !!installed && installed === to;
        const latest = this.last?.latest ?? null;
        const updateAvailable = !!installed && !!latest && compareSemver(latest, installed) > 0;
        this.last = {
          current: installed,
          latest,
          updateAvailable,
          latestUnsupported: updateAvailable && !isHerdrVersionSupported(latest),
          ...supportFlags(installed),
          notes: this.last?.notes ?? null,
          checkedAt: Date.now(),
          error: ok ? undefined : "herdr was not downgraded",
        };
        this.publish();
        result = ok
          ? { ok: true, from, to }
          : { ok: false, from, to: installed, error: "herdr was not downgraded" };
      }
    } catch (err) {
      // URL resolution / cross-check / spawn failed — the binary was never touched;
      // report what we're actually on (never the target). A pre-flight refusal (bad
      // manifest, URL divergence, unsupported platform) never reaches buildDowngradeScript,
      // so it otherwise leaves NO trace anywhere: no audit-log block (script never ran),
      // no onLog line, no console output — only `done.error`, which the modal's fail
      // branch used to drop silently. Surface it on both live surfaces before it ships.
      const message = err instanceof Error ? err.message : "herdr downgrade failed";
      console.warn(`[herdr-update] downgrade failed before touching the binary: ${message}`);
      this.onLog(`herdr downgrade failed: ${message}`);
      result = {
        ok: false,
        from,
        to: this.actualVersion(from),
        error: message,
      };
    } finally {
      clearTimeout(watchdog);
      this.maintenance.end();
      this.applying = false;
      this.phase = "idle";
    }
    this.finish(result);
  }

  /** Re-read the installed herdr version and the latest published one, then
   *  compare. On any failure returns updateAvailable:false with an error set. */
  async check(now: number): Promise<HerdrUpdateStatus> {
    const revision = this.revision;
    try {
      const currentMatch = SEMVER_RE.exec(this.versionRunner());
      let current = currentMatch ? currentMatch[1]! : null;
      // Keep the driver's spawn guard in sync with what's actually installed (catches an
      // out-of-band `herdr update` between boot and this periodic check).
      setDetectedHerdrVersion(current);

      const latestRaw = await this.fetchLatest();
      if (revision !== this.revision && this.last) current = this.last.current;
      const latestMatch = latestRaw?.version ? SEMVER_RE.exec(latestRaw.version) : null;
      const latest = latestMatch ? latestMatch[1]! : null;

      const updateAvailable = !!current && !!latest && compareSemver(latest, current) > 0;
      // A newer-but-unsupported latest (past the supported ceiling) still shows the badge/modal, but
      // the modal warns and the updater refuses it — see apply() + HerdrUpdateModal.
      const latestUnsupported = updateAvailable && !isHerdrVersionSupported(latest);

      this.last = {
        current,
        latest,
        updateAvailable,
        latestUnsupported,
        ...supportFlags(current),
        ...sandboxFlags(this.sandboxedInUse()),
        notes: updateAvailable ? (latestRaw.notes ?? null) : null,
        checkedAt: now,
      };
    } catch (e) {
      this.last = {
        current: this.last?.current ?? null,
        latest: null,
        updateAvailable: false,
        ...supportFlags(this.last?.current ?? null),
        ...sandboxFlags(this.sandboxedInUse()),
        notes: null,
        checkedAt: now,
        error: e instanceof Error ? e.message : "herdr update check failed",
      };
    }
    this.publish();
    return this.current()!;
  }
}
