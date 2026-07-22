import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { execFileSync } from "./instrument";
import { config } from "./config";
import { compareSemver } from "./herdr-update";
import { runScriptChild } from "./script-child";
import { readInstalledVersion, readActualVersion } from "./version-probe";
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

/** The two installers that can update the codex on PATH. Which one actually
 *  WORKS is a property of the host, not something either side can know up front
 *  — see {@link buildUpdateScript}. */
export type CodexUpdateChannel = "npm" | "codex";

/** Marker the script emits once the on-PATH version has ADVANCED, naming the
 *  channel that did it. This is the ONLY attribution of a winning channel:
 *  shepherd's own `ok` (a compareSemver against the last known version) says
 *  THAT we converged, never BY WHAT. Parsed into the channel memo. */
export const CONVERGED_MARKER = `${CODEX_UPDATE_LOG_PREFIX} converged via channel=`;

/**
 * The shell program shepherd spawns as a managed child. Extracted + exported
 * so its sequencing is unit-testable without a live codex release.
 *
 * There are two ways to update codex, and **which one works is a property of the
 * host**:
 * - **`codex update`** (`<codexBin> update`) — codex's own updater. It is
 *   install-kind aware and re-runs whichever installer it believes owns it, so on a
 *   standalone install it repoints the on-PATH `~/.local/bin/codex` where a blind
 *   `npm install -g` would have updated a shadowed copy and left the on-PATH codex
 *   put (issue #1560).
 * - **`npm install -g @openai/codex`** — updates the npm-global copy.
 *
 * Neither is universally right. `codex update` SELF-SELECTS its channel, and that
 * choice can miss the install actually on PATH: on a host whose on-PATH `codex` is
 * a wrapper resolving to the npm-global copy, `codex update` may run `bun install
 * -g`, succeed, exit 0 — and change nothing the operator runs. Success therefore
 * cannot be read off the exit code; only a re-read `codex --version` that ADVANCED
 * proves an update landed.
 *
 * So the script **tries a channel, verifies, and falls back to the other one** —
 * and shepherd REMEMBERS which one won (`preferred`, the channel memo), so the
 * next update leads with it. Steady state is therefore ONE installer run per
 * update on every host shape; the fallback fires only when the memo misses (a host
 * that changed channels), which rewrites the memo. With no memo yet, the order is
 * `codex update` then npm — the historical order, so a fresh host is never worse
 * off than before.
 *
 * Safety rails baked into the script:
 * - **Probe first.** `codex update` is only ever invoked if `codex --help`
 *   advertises the subcommand. A codex too old to have it would otherwise treat
 *   `update` as an interactive prompt; `--help` just prints help and exits, never
 *   runs an agent. When absent, npm is the only channel — including as a fallback.
 * - **Advancement, never exit code, decides.** A channel counts as the winner only
 *   if `codex --version` moved. An installer that no-ops while exiting 0 falls
 *   through to the other channel, so old/odd hosts never silently stall.
 * - **`export CODEX_NON_INTERACTIVE=1`** so the standalone installer path runs unattended.
 *
 * Every run appends ONE delimited block to `logPath` (default
 * ~/.shepherd/codex-update.log) via `tee -a`: a `=== codex-update <UTC> <from> ->
 * <to> ===` header, on-PATH diagnostics (resolved path, symlink target, all
 * `codex` on PATH — surfaces the documented PATH-duplicate non-convergence mode),
 * the per-channel step markers (`channel=<ch> (source=memo|default|fallback)`), raw
 * updater output, the `converged via channel=` verdict, and the post-update
 * version. The script writes this file itself so the record is COMPLETE even if
 * shepherd crashes.
 *
 * @param preferred channel to try FIRST (the memo); null → historical order.
 */
export function buildUpdateScript(
  logPath: string,
  from: string | null | undefined,
  to: string | null | undefined,
  codexBin: string,
  preferred: CodexUpdateChannel | null = null,
): string {
  const f = sanitizeVersion(from);
  const t = sanitizeVersion(to);
  // single-quote path + binary for the shell; a literal `'` inside (vanishingly
  // unlikely) is escaped via the classic '\'' close-reopen trick.
  const q = `'${logPath.replace(/'/g, "'\\''")}'`;
  const cx = `'${codexBin.replace(/'/g, "'\\''")}'`;
  const P = CODEX_UPDATE_LOG_PREFIX;
  // `preferred` is a closed union, never interpolated from an external string.
  const pref = preferred === "npm" || preferred === "codex" ? preferred : "";
  const readVersion = `"$CX" --version 2>/dev/null | grep -oE '[0-9]+[.][0-9]+[.][0-9]+' | head -1`;
  return [
    `LOG=${q}`,
    `CX=${cx}`,
    `PREF='${pref}'`,
    'mkdir -p "$(dirname "$LOG")"',
    "{",
    `  echo "=== codex-update $(date -u +%Y-%m-%dT%H:%M:%SZ) ${f} -> ${t} ==="`,
    "  export CODEX_NON_INTERACTIVE=1",
    `  before="$(${readVersion})"`,
    `  cxpath="$(command -v "$CX" 2>/dev/null || echo '<not found>')"`,
    `  echo "${P} on-PATH codex: $cxpath"`,
    `  echo "${P} symlink target: $(readlink "$cxpath" 2>/dev/null || echo '<none>')"`,
    // bare-name `type -a codex` (not "$CX", which just echoes an absolute path)
    // reveals PATH duplicates — the documented cause of a non-converging update.
    `  dups="$(type -a codex 2>/dev/null || true)"`,
    `  echo "${P} codex on PATH:" $dups`,
    // Probe once: a codex without the subcommand leaves npm as the ONLY channel,
    // so it must never appear in the order — not even as the fallback.
    `  if "$CX" --help 2>/dev/null | grep -qE '^[[:space:]]+update[[:space:]]'; then`,
    "    has_update=1",
    "  else",
    `    echo '${P} codex update subcommand not present; using npm'`,
    "    has_update=0",
    "  fi",
    // Channel order: memo first when we have one and it is runnable, else the
    // historical order (codex update, then npm).
    `  if [ "$has_update" -eq 0 ]; then order='npm'; src='default'`,
    `  elif [ "$PREF" = 'npm' ]; then order='npm codex'; src='memo'`,
    `  elif [ "$PREF" = 'codex' ]; then order='codex npm'; src='memo'`,
    `  else order='codex npm'; src='default'; fi`,
    "  winner=''",
    `  after="$before"`,
    "  step=0",
    "  for ch in $order; do",
    "    step=$((step+1))",
    `    if [ "$step" -eq 1 ]; then s="$src"; else s='fallback'; fi`,
    `    echo "${P} channel=$ch (source=$s)"`,
    `    if [ "$ch" = 'codex' ]; then`,
    `      "$CX" update; rc=$?`,
    `      echo "${P} codex update exited rc=$rc"`,
    "    else",
    "      npm install -g @openai/codex; rc=$?",
    `      echo "${P} npm install exited rc=$rc"`,
    "    fi",
    // Drop bash's cached command→path table before re-reading. `$CX` is normally
    // the BARE name `codex`, whose path bash hashed on the `before` read; an
    // installer that drops codex into an EARLIER PATH dir (a standalone installer
    // repointing ~/.local/bin) would otherwise be re-read through the stale hashed
    // path and look like it did not advance. The winner test now decides what gets
    // memoized, so a false negative here would be persisted.
    "    hash -r 2>/dev/null || true",
    `    after="$(${readVersion})"`,
    // The ONLY success test: did the codex we actually run move? An installer
    // that exits 0 but updates some other copy is not a winner.
    `    if [ "$after" != "$before" ]; then winner="$ch"; break; fi`,
    `    echo "${P} channel=$ch did not advance codex ($before)"`,
    "  done",
    `  if [ -n "$winner" ]; then`,
    `    echo "${CONVERGED_MARKER}$winner"`,
    "  else",
    `    echo '${P} did not converge'`,
    "  fi",
    `  echo "${P} codex --version now: $("$CX" --version 2>/dev/null || echo '<unreadable>')"`,
    '} 2>&1 | tee -a "$LOG"',
  ].join("\n");
}

/** Best-effort resolve the codex binary as it sits on PATH, for the "which codex
 *  is actually stuck?" diagnostic. Pure PATH scan (no subprocess) so it never
 *  spawns or throws; an absolute/relative `codexBin` is reported as-is; null if
 *  nothing resolves. */
function defaultResolveOnPath(codexBin: string): string | null {
  try {
    if (codexBin.includes("/")) return codexBin;
    const dirs = (process.env.PATH ?? "").split(delimiter);
    for (const dir of dirs) {
      if (!dir) continue;
      const candidate = join(dir, codexBin);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

/** Terminal outcome of an apply(), emitted once via onDone. Drives the modal's
 *  ✓/✗ state. Success is decided by whether the re-read `codex --version`
 *  ADVANCED, NOT the child's exit code (a no-op update still exits 0). */
export interface CodexUpdateResult {
  ok: boolean;
  from: string | null;
  to: string | null;
  error?: string;
  /** On a NON-converged update (version did not advance), the codex binary as
   *  resolved on PATH — so the modal can name WHICH install is stuck (a separate
   *  PATH duplicate, or an already-latest no-op) instead of a blind retry loop.
   *  null/absent on success or when it can't be resolved. */
  onPathBinary?: string | null;
}

export interface CodexUpdateDeps {
  /** inject point for tests; defaults to running the codex binary's --version */
  versionRunner?: () => string;
  /** inject point for tests; defaults to fetching the npm registry manifest */
  fetchLatest?: () => Promise<{ version: string }>;
  /**
   * Run the update child, streaming each output line to onLine, resolving when
   * it exits. The AbortSignal fires on watchdog timeout — the default kills the
   * child. `preferred` is the channel memo (null → historical order). Default:
   * spawn `bash -lc <buildUpdateScript>`.
   */
  runUpdate?: (
    onLine: (line: string) => void,
    signal: AbortSignal,
    preferred: CodexUpdateChannel | null,
  ) => Promise<void>;
  /** each log line streamed from the running update; default: no-op */
  onLog?: (line: string) => void;
  /** the recomputed status after the update settles; default: no-op */
  onStatus?: (status: CodexUpdateStatus) => void;
  /** the terminal result, emitted exactly once per apply(); default: no-op */
  onDone?: (result: CodexUpdateResult) => void;
  /** inject point for tests; resolve the on-PATH codex for the stuck-update
   *  diagnostic. Default: a pure PATH scan of `config.codexBin`. */
  resolveOnPathBinary?: () => string | null;
  /** the channel memo: which installer last ADVANCED the on-PATH codex. Tried
   *  first on the next update. null → no memo yet (historical order). */
  readChannel?: () => CodexUpdateChannel | null;
  /** persist the winning channel. Called ONLY on a converged run that named its
   *  winner — see {@link CodexUpdateService.settleUpdate}. */
  writeChannel?: (channel: CodexUpdateChannel) => void;
  /** watchdog ceiling before a hung update is force-killed (default 5min) */
  watchdogMs?: number;
}

/**
 * Tracks whether a newer @openai/codex (the OpenAI Codex CLI, one of Shepherd's
 * agent runtimes) is published on npm and, on demand, updates it for the
 * operator. It surfaces a badge keyed off `updateAvailable`.
 *
 * Modelled on {@link HerdrUpdateService}: the check parses the installed version
 * from `codex --version` and compares it against the npm registry. It is
 * fail-safe — any error (binary missing, network down, malformed payload) yields
 * updateAvailable:false, so a broken check can never raise a false badge.
 *
 * `apply()` spawns {@link buildUpdateScript} as a managed child of shepherd (no
 * shepherd restart). That script tries the two installers — `codex update` and
 * `npm install -g @openai/codex` — in the order given by the **channel memo**
 * (`readChannel`), stopping at the first one that actually moves the on-PATH
 * version; neither channel is inherently "the primary", and with a memo of `npm`
 * the run may never invoke `codex update` at all. Because the update is
 * non-destructive, running codex panes are not interrupted.
 *
 * Success is determined by whether a re-read `codex --version` ADVANCED past the
 * prior version — channel-agnostic, so a standalone update whose version differs
 * from npm-latest still counts. On success the winning channel is persisted via
 * `writeChannel` so the next update leads with it (one installer run, not a
 * try-fail-retry). The terminal result is emitted via onDone; a non-converged
 * update carries the on-PATH binary so the modal can explain which install is
 * stuck.
 */
export class CodexUpdateService {
  private versionRunner: () => string;
  private fetchLatest: () => Promise<{ version: string }>;
  private runUpdate: (
    onLine: (line: string) => void,
    signal: AbortSignal,
    preferred: CodexUpdateChannel | null,
  ) => Promise<void>;
  private onLog: (line: string) => void;
  private onStatus: (status: CodexUpdateStatus) => void;
  private onDone: (result: CodexUpdateResult) => void;
  private resolveOnPathBinary: () => string | null;
  private readChannel: () => CodexUpdateChannel | null;
  private writeChannel: (channel: CodexUpdateChannel) => void;
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
    this.runUpdate =
      deps.runUpdate ??
      ((onLine, signal, preferred) => this.defaultRunUpdate(onLine, signal, preferred));
    this.onLog = deps.onLog ?? (() => {});
    this.onStatus = deps.onStatus ?? (() => {});
    this.onDone = deps.onDone ?? (() => {});
    this.resolveOnPathBinary =
      deps.resolveOnPathBinary ?? (() => defaultResolveOnPath(config.codexBin));
    this.readChannel = deps.readChannel ?? (() => null);
    this.writeChannel = deps.writeChannel ?? (() => {});
    this.watchdogMs = deps.watchdogMs ?? 5 * 60 * 1000;
  }

  /** Read the channel memo, degrading a throwing store (locked SQLite) to null.
   *  The memo only picks which installer we TRY FIRST — it is an optimisation,
   *  never a precondition — so a failed read must cost us the head start, not the
   *  update: null simply restores the historical order (`codex update`, then npm),
   *  and the cross-fallback still converges. Mirrors the write side. */
  private readChannelSafe(): CodexUpdateChannel | null {
    try {
      return this.readChannel();
    } catch (err) {
      console.warn(
        `[codex-update] could not read the channel memo, using the default order: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** Spawn `bash -lc <script>` in shepherd's own process tree (NOT detached —
   *  there is no shepherd restart to outlive), stream stdout+stderr to onLine,
   *  resolve on exit. The signal (watchdog) force-kills a hung child. */
  private defaultRunUpdate(
    onLine: (line: string) => void,
    signal: AbortSignal,
    preferred: CodexUpdateChannel | null,
  ): Promise<void> {
    const script = buildUpdateScript(
      config.codexUpdateLogPath,
      this.last?.current,
      this.last?.latest,
      config.codexBin,
      preferred,
    );
    return runScriptChild(script, onLine, signal, "codex update");
  }

  /** Parse the installed version from `codex --version`; null if unreadable. */
  private installedVersion(): string | null {
    return readInstalledVersion(this.versionRunner, SEMVER_RE);
  }

  /** Best-effort installed version for the "what are we ACTUALLY on?" report.
   *  Never throws (a missing/exploding `codex --version` falls back to `fallback`,
   *  the last-known-good). Used by every failure branch so we never tell the
   *  operator they're on the target version we know they did NOT reach. */
  private actualVersion(fallback: string | null): string | null {
    return readActualVersion(this.versionRunner, SEMVER_RE, fallback);
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

  /** Run the update, streaming lines to onLog, and scrape the two markers only
   *  the script can report: the login-shell codex path (`command -v` under `bash
   *  -lc` — the AUTHORITATIVE resolution) and the channel that converged. Either
   *  is null if its line never arrived (an injected runUpdate, a truncated
   *  stream); a null channel means the run is NOT attributable and must not touch
   *  the memo. */
  private async runUpdateCapturingPath(
    signal: AbortSignal,
    preferred: CodexUpdateChannel | null,
  ): Promise<{ onPath: string | null; channel: CodexUpdateChannel | null }> {
    const pathMarker = `${CODEX_UPDATE_LOG_PREFIX} on-PATH codex:`;
    let onPath: string | null = null;
    let channel: CodexUpdateChannel | null = null;
    await this.runUpdate(
      (line) => {
        const at = line.indexOf(pathMarker);
        if (at !== -1) {
          const val = line.slice(at + pathMarker.length).trim();
          onPath = val && val !== "<not found>" ? val : null;
        }
        const ch = line.indexOf(CONVERGED_MARKER);
        if (ch !== -1) {
          const val = line.slice(ch + CONVERGED_MARKER.length).trim();
          if (val === "npm" || val === "codex") channel = val;
        }
        this.onLog(line);
      },
      signal,
      preferred,
    );
    return { onPath, channel };
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
      // Run the update; capture the login-shell-resolved codex path the script
      // logs (the AUTHORITATIVE resolution — a standalone ~/.local/bin/codex may be
      // on PATH only via a shell profile Node's process.env.PATH doesn't reflect).
      // Read the memo HERE, not inside the spawn: it only picks which installer we
      // try first, so a throwing store degrades to the historical order (null) —
      // it must never cancel an update that would otherwise have run.
      const { onPath, channel } = await this.runUpdateCapturingPath(
        ctrl.signal,
        this.readChannelSafe(),
      );
      result = this.settleUpdate(from, to, onPath, channel, ctrl.signal.aborted);
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

  /** Decide the outcome from a re-read `codex --version`: success iff the on-PATH
   *  version ADVANCED past `from` (channel-agnostic — a standalone update whose
   *  latest differs from npm-latest still counts, where an exact match check would
   *  falsely loop). Emits the recomputed status; returns the terminal result. On
   *  non-convergence it names WHICH binary is stuck (a PATH-duplicate install or an
   *  already-latest no-op), preferring the script-logged login-shell path and
   *  falling back to a Node PATH scan when that line wasn't captured. */
  private settleUpdate(
    from: string | null,
    to: string | null,
    onPathFromLog: string | null,
    channel: CodexUpdateChannel | null,
    aborted: boolean,
  ): CodexUpdateResult {
    // Re-read once: it decides success AND is the version every failure branch
    // reports as "what we're actually on" (never the target we did not reach).
    const after = this.actualVersion(from);
    // A force-killed run proves nothing: return BEFORE the memo write below, so a
    // later refactor cannot start memoizing a channel from a killed update.
    if (aborted) return { ok: false, from, to: after, error: "codex update timed out" };
    const ok = !!after && !!from && compareSemver(after, from) > 0;
    // Memo the winner ONLY when we converged AND the script named the channel that
    // did it. `ok` is our own compareSemver verdict — it says THAT codex advanced,
    // never BY WHAT — so with no marker there is nothing to attribute and we leave
    // the memo untouched (never cleared, never guessed). A non-converged run never
    // writes, so a failure cannot poison a good memo.
    //
    // The memo is BOOKKEEPING, not the outcome: codex is already updated on disk by
    // now. A throwing store (SQLite locked) must therefore never turn a converged
    // update into a reported failure — it only costs us the optimisation on the
    // next run, so swallow it and keep the verdict.
    if (ok && channel) {
      try {
        this.writeChannel(channel);
      } catch (err) {
        console.warn(
          `[codex-update] converged via ${channel} but could not persist the channel memo: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const onPathBinary = ok ? null : (onPathFromLog ?? this.resolveOnPathBinary());
    this.last = {
      current: after,
      latest: to,
      updateAvailable: !!after && !!to && compareSemver(to, after) > 0,
      notes: null,
      checkedAt: Date.now(),
      error: ok ? undefined : "codex was not updated",
    };
    this.onStatus(this.last);
    return ok
      ? { ok: true, from, to: after }
      : { ok: false, from, to: after, error: "codex was not updated", onPathBinary };
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
