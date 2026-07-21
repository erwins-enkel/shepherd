import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { execFileSync } from "./instrument";
import { config } from "./config";
import { runScriptChild } from "./script-child";
import { readInstalledVersion, readActualVersion } from "./version-probe";
import type { CodexReleaseNotesResult, CodexUpdateStatus } from "./types";

export type { CodexReleaseNotesResult, CodexUpdateStatus };

const SEMVER_RE = /(\d+\.\d+\.\d+)/;
const NPM_STABLE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** npm registry manifest for the latest published @openai/codex. Returns the
 *  full packument for the `latest` dist-tag, which carries the `version` field. */
const LATEST_URL = "https://registry.npmjs.org/@openai/codex/latest";
const CATALOG_URL = "https://registry.npmjs.org/@openai%2Fcodex";
const RELEASES_URL = "https://api.github.com/repos/openai/codex/releases";
const HISTORY_PROGRESS_INTERVAL_MS = 60_000;
const HISTORY_REQUEST_TIMEOUT_MS = 5_000;
const HISTORY_LOAD_TIMEOUT_MS = 15_000;
const NPM_RESPONSE_LIMIT = 8 * 1024 * 1024;
const GITHUB_RESPONSE_LIMIT = 12 * 1024 * 1024;
const INVOCATION_RESPONSE_LIMIT = 32 * 1024 * 1024;
const RELEASE_BODY_LIMIT = 256 * 1024;
const RELEASE_BODIES_LIMIT = 1024 * 1024;
const GITHUB_RATE_RESERVE = 10;

let githubBlockedUntil = 0;

function parseNpmStableVersion(value: unknown): string | null {
  return typeof value === "string" && NPM_STABLE_VERSION_RE.test(value) ? value : null;
}

function compareVersionComponent(a: string, b: string): number {
  const normalizedA = a.replace(/^0+(?=\d)/, "");
  const normalizedB = b.replace(/^0+(?=\d)/, "");
  if (normalizedA.length !== normalizedB.length) {
    return normalizedA.length < normalizedB.length ? -1 : 1;
  }
  return normalizedA === normalizedB ? 0 : normalizedA < normalizedB ? -1 : 1;
}

function compareStableVersions(a: string, b: string): number {
  const aParts = a.split(".");
  const bParts = b.split(".");
  for (let i = 0; i < 3; i++) {
    const compared = compareVersionComponent(aParts[i]!, bParts[i]!);
    if (compared !== 0) return compared;
  }
  return 0;
}

interface ReleaseNotesProgress {
  key: string;
  current: string;
  latest: string;
  inFlight?: Promise<CodexReleaseNotesResult>;
  result?: CodexReleaseNotesResult;
  catalogLoaded: boolean;
  catalogComplete: boolean;
  targets: Set<string>;
  unresolved: Set<string>;
  notesByVersion: Map<string, string>;
  terminalFailures: Set<string>;
  nextListPage: number;
  listExhausted: boolean;
  outputIncomplete: boolean;
  bodyBytes: number;
  nextAttemptAt: number;
}

interface HistoryBudget {
  bytes: number;
}

interface BoundedJsonResult {
  value: unknown;
  headers: Headers;
}

type HistoryFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

class HistoryHttpError extends Error {
  constructor(
    readonly status: number,
    readonly headers: Headers,
  ) {
    super(`history request failed: ${status}`);
  }
}

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
  /** on-demand npm/GitHub transport; separate from periodic status checks */
  fetchHistory?: HistoryFetch;
  /** deterministic clock and retry interval seams for bounded history tests */
  historyNow?: () => number;
  historyProgressIntervalMs?: number;
  historyRequestTimeoutMs?: number;
  historyLoadTimeoutMs?: number;
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
  private fetchHistory: HistoryFetch;
  private historyNow: () => number;
  private historyProgressIntervalMs: number;
  private historyRequestTimeoutMs: number;
  private historyLoadTimeoutMs: number;
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
  private notesCache: ReleaseNotesProgress | null = null;

  constructor(deps: CodexUpdateDeps = {}) {
    this.versionRunner =
      deps.versionRunner ??
      (() => execFileSync(config.codexBin, ["--version"], { encoding: "utf8" }));
    this.fetchHistory = deps.fetchHistory ?? ((input, init) => fetch(input, init));
    this.historyNow = deps.historyNow ?? Date.now;
    this.historyProgressIntervalMs = deps.historyProgressIntervalMs ?? HISTORY_PROGRESS_INTERVAL_MS;
    this.historyRequestTimeoutMs = deps.historyRequestTimeoutMs ?? HISTORY_REQUEST_TIMEOUT_MS;
    this.historyLoadTimeoutMs = deps.historyLoadTimeoutMs ?? HISTORY_LOAD_TIMEOUT_MS;
    this.fetchLatest =
      deps.fetchLatest ??
      (async () => {
        const controller = new AbortController();
        const { value } = await this.boundedJson(
          LATEST_URL,
          NPM_RESPONSE_LIMIT,
          { bytes: 0 },
          controller.signal,
        );
        return value as { version: string };
      });
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

  private liveNotesRange(): { current: string; latest: string; key: string } | null {
    const current = this.last?.current;
    const latest = parseNpmStableVersion(this.last?.latest);
    if (
      !this.last?.updateAvailable ||
      !current ||
      !latest ||
      compareStableVersions(latest, current) <= 0
    ) {
      return null;
    }
    return { current, latest, key: `${current} -> ${latest}` };
  }

  private releaseNotesResult(progress: ReleaseNotesProgress): CodexReleaseNotesResult {
    const notes = [...progress.notesByVersion.entries()]
      .filter(([, body]) => body !== "")
      .sort(([a], [b]) => compareStableVersions(b, a))
      .map(([version, body]) => ({ version, body }));
    return {
      current: progress.current,
      latest: progress.latest,
      notes,
      complete:
        progress.catalogComplete &&
        progress.unresolved.size === 0 &&
        progress.terminalFailures.size === 0 &&
        !progress.outputIncomplete,
    };
  }

  private async boundedJson(
    url: string,
    perResponseLimit: number,
    budget: HistoryBudget,
    loadSignal: AbortSignal,
    github = false,
  ): Promise<BoundedJsonResult> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (loadSignal.aborted) controller.abort();
    else loadSignal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, this.historyRequestTimeoutMs);
    try {
      const response = await this.fetchHistory(url, {
        signal: controller.signal,
        headers: github
          ? {
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "Shepherd",
            }
          : { Accept: "application/vnd.npm.install-v1+json" },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new HistoryHttpError(response.status, response.headers);
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > perResponseLimit) {
        await response.body?.cancel();
        throw new Error("history response too large");
      }
      if (!response.body) throw new Error("history response has no body");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let responseBytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          responseBytes += value.byteLength;
          budget.bytes += value.byteLength;
          if (responseBytes > perResponseLimit || budget.bytes > INVOCATION_RESPONSE_LIMIT) {
            await reader.cancel();
            throw new Error("history response too large");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const joined = new Uint8Array(responseBytes);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(joined);
      return { value: JSON.parse(decoded), headers: response.headers };
    } finally {
      clearTimeout(timeout);
      loadSignal.removeEventListener("abort", abort);
    }
  }

  private noteRateLimit(headers: Headers): boolean {
    const now = this.historyNow();
    const remainingRaw = headers.get("x-ratelimit-remaining");
    const resetRaw = headers.get("x-ratelimit-reset");
    if (remainingRaw === null && resetRaw === null) {
      githubBlockedUntil = Math.max(githubBlockedUntil, now + this.historyProgressIntervalMs);
      return false;
    }
    const remaining = Number(remainingRaw);
    const reset = Number(resetRaw);
    if (!Number.isFinite(remaining) || !Number.isFinite(reset)) {
      githubBlockedUntil = Math.max(githubBlockedUntil, now + this.historyProgressIntervalMs);
      return false;
    }
    if (remaining <= GITHUB_RATE_RESERVE) {
      githubBlockedUntil = Math.max(githubBlockedUntil, reset * 1000);
      return false;
    }
    return true;
  }

  private noteRateFailure(error: unknown): boolean {
    if (!(error instanceof HistoryHttpError) || (error.status !== 403 && error.status !== 429)) {
      return false;
    }
    const now = this.historyNow();
    const retryAfter = Number(error.headers.get("retry-after"));
    const reset = Number(error.headers.get("x-ratelimit-reset"));
    const retryAt = Number.isFinite(retryAfter) ? now + retryAfter * 1000 : 0;
    const resetAt = Number.isFinite(reset) ? reset * 1000 : 0;
    githubBlockedUntil = Math.max(
      githubBlockedUntil,
      retryAt,
      resetAt,
      now + this.historyProgressIntervalMs,
    );
    return true;
  }

  private admitRelease(progress: ReleaseNotesProgress, raw: unknown, exact?: string): boolean {
    const release = this.parseRelease(raw, exact, progress.targets);
    if (!release) return false;
    const { version, body } = release;
    if (!progress.unresolved.has(version)) {
      if (progress.notesByVersion.get(version) !== body) progress.terminalFailures.add(version);
      return true;
    }
    const bodyBytes = new TextEncoder().encode(body).byteLength;
    progress.unresolved.delete(version);
    if (bodyBytes > RELEASE_BODY_LIMIT || progress.bodyBytes + bodyBytes > RELEASE_BODIES_LIMIT) {
      progress.outputIncomplete = true;
      progress.terminalFailures.add(version);
      return true;
    }
    progress.notesByVersion.set(version, body);
    progress.bodyBytes += bodyBytes;
    return true;
  }

  private parseRelease(
    raw: unknown,
    exact: string | undefined,
    targets: Set<string>,
  ): { version: string; body: string } | null {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    const tag = typeof value.tag_name === "string" ? value.tag_name : "";
    const version = tag.startsWith("rust-v") ? parseNpmStableVersion(tag.slice(6)) : null;
    if (!version || (exact && version !== exact) || !targets.has(version)) return null;
    if (value.draft !== false || value.prerelease !== false) return null;
    if (value.body !== null && typeof value.body !== "string") return null;
    return { version, body: value.body ?? "" };
  }

  private newestUnresolved(progress: ReleaseNotesProgress): string | null {
    return [...progress.unresolved].sort(compareStableVersions).at(-1) ?? null;
  }

  private async loadReleaseCatalog(
    progress: ReleaseNotesProgress,
    budget: HistoryBudget,
    signal: AbortSignal,
  ): Promise<void> {
    progress.catalogLoaded = true;
    try {
      const { value } = await this.boundedJson(CATALOG_URL, NPM_RESPONSE_LIMIT, budget, signal);
      if (!value || typeof value !== "object" || !("versions" in value)) {
        throw new Error("invalid npm catalog");
      }
      const versions = (value as { versions?: unknown }).versions;
      if (!versions || typeof versions !== "object" || Array.isArray(versions)) {
        throw new Error("invalid npm catalog");
      }
      let includesLatest = false;
      for (const candidate of Object.keys(versions)) {
        const version = parseNpmStableVersion(candidate);
        if (!version) continue;
        if (version === progress.latest) includesLatest = true;
        if (
          compareStableVersions(version, progress.current) > 0 &&
          compareStableVersions(version, progress.latest) <= 0
        ) {
          progress.targets.add(version);
          progress.unresolved.add(version);
        }
      }
      progress.catalogComplete = includesLatest;
    } catch {
      progress.catalogComplete = false;
      progress.listExhausted = true;
    }
  }

  private async loadReleasePage(
    progress: ReleaseNotesProgress,
    budget: HistoryBudget,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      const { value, headers } = await this.boundedJson(
        `${RELEASES_URL}?per_page=30&page=${progress.nextListPage}`,
        GITHUB_RESPONSE_LIMIT,
        budget,
        signal,
        true,
      );
      if (!Array.isArray(value)) throw new Error("invalid GitHub releases page");
      for (const record of value) this.admitRelease(progress, record);
      const link = headers.get("link") ?? "";
      if (link.includes('rel="next"')) progress.nextListPage++;
      else progress.listExhausted = true;
      return this.noteRateLimit(headers);
    } catch (error) {
      if (this.noteRateFailure(error)) return false;
      progress.listExhausted = true;
      return true;
    }
  }

  private async loadExactReleases(
    progress: ReleaseNotesProgress,
    budget: HistoryBudget,
    signal: AbortSignal,
    requestLimit: number,
  ): Promise<void> {
    for (let request = 0; request < requestLimit && progress.unresolved.size > 0; request++) {
      const version = this.newestUnresolved(progress);
      if (!version) return;
      try {
        const { value, headers } = await this.boundedJson(
          `${RELEASES_URL}/tags/rust-v${version}`,
          GITHUB_RESPONSE_LIMIT,
          budget,
          signal,
          true,
        );
        if (!this.admitRelease(progress, value, version)) {
          progress.unresolved.delete(version);
          progress.terminalFailures.add(version);
        }
        if (!this.noteRateLimit(headers)) return;
      } catch (error) {
        if (error instanceof HistoryHttpError && error.status === 404) {
          progress.unresolved.delete(version);
          progress.terminalFailures.add(version);
        } else {
          this.noteRateFailure(error);
        }
        return;
      }
    }
  }

  private async loadReleaseNotes(progress: ReleaseNotesProgress): Promise<CodexReleaseNotesResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.historyLoadTimeoutMs);
    const budget: HistoryBudget = { bytes: 0 };
    let githubRequests = 0;
    try {
      if (!progress.catalogLoaded)
        await this.loadReleaseCatalog(progress, budget, controller.signal);

      if (this.historyNow() < githubBlockedUntil) return this.releaseNotesResult(progress);

      if (!progress.listExhausted && progress.unresolved.size > 0) {
        githubRequests++;
        const canContinue = await this.loadReleasePage(progress, budget, controller.signal);
        if (!canContinue) return this.releaseNotesResult(progress);
      }

      await this.loadExactReleases(progress, budget, controller.signal, 2 - githubRequests);
    } catch {
      // The public contract is total: accumulated notes remain available.
    } finally {
      clearTimeout(timeout);
      progress.nextAttemptAt = Math.max(
        this.historyNow() + this.historyProgressIntervalMs,
        githubBlockedUntil,
      );
    }
    return this.releaseNotesResult(progress);
  }

  /** Load original GitHub release bodies only when the update dialog asks. */
  releaseNotes(): Promise<CodexReleaseNotesResult> {
    const range = this.liveNotesRange();
    if (!range) {
      this.notesCache = null;
      return Promise.resolve({
        current: this.last?.current ?? null,
        latest: this.last?.latest ?? null,
        notes: [],
        complete: true,
      });
    }

    let entry = this.notesCache;
    if (!entry || entry.key !== range.key) {
      entry = {
        ...range,
        catalogLoaded: false,
        catalogComplete: false,
        targets: new Set([range.latest]),
        unresolved: new Set([range.latest]),
        notesByVersion: new Map(),
        terminalFailures: new Set(),
        nextListPage: 1,
        listExhausted: false,
        outputIncomplete: false,
        bodyBytes: 0,
        nextAttemptAt: 0,
      };
      this.notesCache = entry;
    }
    if (entry.inFlight) return entry.inFlight;
    if (entry.result?.complete || (entry.result && this.historyNow() < entry.nextAttemptAt)) {
      return Promise.resolve(entry.result);
    }

    const capturedEntry = entry;
    const promise = this.loadReleaseNotes(capturedEntry).then((result) => {
      if (this.notesCache === capturedEntry && capturedEntry.inFlight === promise) {
        capturedEntry.result = result;
        capturedEntry.inFlight = undefined;
      }
      return result;
    });
    capturedEntry.inFlight = promise;
    return promise;
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
    const ok = !!after && !!from && compareStableVersions(after, from) > 0;
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
      updateAvailable: !!after && !!to && compareStableVersions(to, after) > 0,
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
      const latest = parseNpmStableVersion(latestRaw?.version);

      const updateAvailable = !!current && !!latest && compareStableVersions(latest, current) > 0;

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
