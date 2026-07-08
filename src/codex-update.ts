import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
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
 * Updates via codex's own **`codex update`** subcommand (`<codexBin> update`),
 * which is install-kind aware: on an npm install it reruns `npm install -g
 * @openai/codex`; on a standalone install it reruns the standalone installer,
 * repointing the on-PATH `~/.local/bin/codex`. It therefore updates the SAME
 * binary shepherd re-reads to verify — closing the npm/standalone mismatch that
 * made `npm install -g` update a shadowed copy while the on-PATH codex stayed put
 * (issue #1560). `codex update` is NON-destructive (swaps the binary on disk;
 * running codex panes keep their loaded build, only new sessions pick it up), so
 * there is no handoff, no server restart, and no recovery branch.
 *
 * Safety rails baked into the script:
 * - **Probe first.** We only invoke `codex update` if `codex --help` advertises
 *   the subcommand. A codex too old to have it would otherwise treat `update` as
 *   an interactive prompt; `--help` just prints help and exits, never runs an agent.
 * - **npm fallback gated on non-advancement.** If the subcommand is absent OR the
 *   version did not advance (`after == before`), fall back to `npm install -g
 *   @openai/codex`. Gating on the version — not the exit code — means an old codex
 *   that silently no-ops still falls back, so old-npm hosts never regress.
 * - **`export CODEX_NON_INTERACTIVE=1`** so the standalone installer path runs unattended.
 *
 * Every run appends ONE delimited block to `logPath` (default
 * ~/.shepherd/codex-update.log) via `tee -a`: a `=== codex-update <UTC> <from> ->
 * <to> ===` header, on-PATH diagnostics (resolved path, symlink target, all
 * `codex` on PATH — surfaces the documented PATH-duplicate non-convergence mode),
 * the step markers, raw updater output, and the post-update version. The script
 * writes this file itself so the record is COMPLETE even if shepherd crashes.
 */
export function buildUpdateScript(
  logPath: string,
  from: string | null | undefined,
  to: string | null | undefined,
  codexBin: string,
): string {
  const f = sanitizeVersion(from);
  const t = sanitizeVersion(to);
  // single-quote path + binary for the shell; a literal `'` inside (vanishingly
  // unlikely) is escaped via the classic '\'' close-reopen trick.
  const q = `'${logPath.replace(/'/g, "'\\''")}'`;
  const cx = `'${codexBin.replace(/'/g, "'\\''")}'`;
  const P = CODEX_UPDATE_LOG_PREFIX;
  return [
    `LOG=${q}`,
    `CX=${cx}`,
    'mkdir -p "$(dirname "$LOG")"',
    "{",
    `  echo "=== codex-update $(date -u +%Y-%m-%dT%H:%M:%SZ) ${f} -> ${t} ==="`,
    "  export CODEX_NON_INTERACTIVE=1",
    `  before="$("$CX" --version 2>/dev/null | grep -oE '[0-9]+[.][0-9]+[.][0-9]+' | head -1)"`,
    `  cxpath="$(command -v "$CX" 2>/dev/null || echo '<not found>')"`,
    `  echo "${P} on-PATH codex: $cxpath"`,
    `  echo "${P} symlink target: $(readlink "$cxpath" 2>/dev/null || echo '<none>')"`,
    // bare-name `type -a codex` (not "$CX", which just echoes an absolute path)
    // reveals PATH duplicates — the documented cause of a non-converging update.
    `  dups="$(type -a codex 2>/dev/null || true)"`,
    `  echo "${P} codex on PATH:" $dups`,
    `  if "$CX" --help 2>/dev/null | grep -qE '^[[:space:]]+update[[:space:]]'; then`,
    `    echo '${P} running codex update'`,
    `    "$CX" update; rc=$?`,
    `    echo "${P} codex update exited rc=$rc"`,
    "    has_update=1",
    "  else",
    `    echo '${P} codex update subcommand not present; using npm'`,
    "    has_update=0",
    "  fi",
    `  after="$("$CX" --version 2>/dev/null | grep -oE '[0-9]+[.][0-9]+[.][0-9]+' | head -1)"`,
    `  if [ "$has_update" -eq 0 ] || [ "$after" = "$before" ]; then`,
    `    echo '${P} falling back to npm install -g @openai/codex'`,
    "    npm install -g @openai/codex; rc=$?",
    `    echo "${P} npm install exited rc=$rc"`,
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
   * child. Default: spawn `bash -lc <buildUpdateScript>`.
   */
  runUpdate?: (onLine: (line: string) => void, signal: AbortSignal) => Promise<void>;
  /** each log line streamed from the running update; default: no-op */
  onLog?: (line: string) => void;
  /** the recomputed status after the update settles; default: no-op */
  onStatus?: (status: CodexUpdateStatus) => void;
  /** the terminal result, emitted exactly once per apply(); default: no-op */
  onDone?: (result: CodexUpdateResult) => void;
  /** inject point for tests; resolve the on-PATH codex for the stuck-update
   *  diagnostic. Default: a pure PATH scan of `config.codexBin`. */
  resolveOnPathBinary?: () => string | null;
  /** watchdog ceiling before a hung update is force-killed (default 5min) */
  watchdogMs?: number;
}

/**
 * Tracks whether a newer @openai/codex (the OpenAI Codex CLI, one of Shepherd's
 * agent runtimes) is published on npm and, on demand, runs `codex update` for the
 * operator. It surfaces a badge keyed off `updateAvailable`.
 *
 * Modelled on {@link HerdrUpdateService}: the check parses the installed version
 * from `codex --version` and compares it against the npm registry. It is
 * fail-safe — any error (binary missing, network down, malformed payload) yields
 * updateAvailable:false, so a broken check can never raise a false badge.
 *
 * `apply()` spawns `codex update` (with an npm fallback) as a managed child of
 * shepherd (no shepherd restart). Because the update is non-destructive, running
 * codex panes are not interrupted. Success is determined by whether a re-read
 * `codex --version` ADVANCED past the prior version — channel-agnostic, so a
 * standalone update whose version differs from npm-latest still counts. The
 * terminal result is emitted via onDone; a non-converged update carries the
 * on-PATH binary so the modal can explain which install is stuck.
 */
export class CodexUpdateService {
  private versionRunner: () => string;
  private fetchLatest: () => Promise<{ version: string }>;
  private runUpdate: (onLine: (line: string) => void, signal: AbortSignal) => Promise<void>;
  private onLog: (line: string) => void;
  private onStatus: (status: CodexUpdateStatus) => void;
  private onDone: (result: CodexUpdateResult) => void;
  private resolveOnPathBinary: () => string | null;
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
    this.resolveOnPathBinary =
      deps.resolveOnPathBinary ?? (() => defaultResolveOnPath(config.codexBin));
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
        config.codexBin,
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
        // Success = the on-PATH version ADVANCED past what we started on. This is
        // channel-agnostic: `codex update` on a standalone install targets the
        // standalone channel, whose latest need not byte-match npm-latest, so an
        // exact `after === npm-latest` check would falsely loop after a real
        // standalone update. If the version went up, the update worked.
        const ok = !!after && !!from && compareSemver(after, from) > 0;
        // On non-convergence, resolve the actual on-PATH codex so the modal can
        // name WHICH binary is stuck (a separate PATH-duplicate install, or an
        // already-latest no-op) instead of a blind, unexplained retry loop.
        const onPathBinary = ok ? null : this.resolveOnPathBinary();
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
          ? { ok: true, from, to: after }
          : { ok: false, from, to: after, error: "codex was not updated", onPathBinary };
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
