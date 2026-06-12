/**
 * Per-session DNS-drop watcher: tails the dnsmasq dns.log written by egress-runner.sh
 * and surfaces blocked-host attempts as operator-visible signals + UI events.
 *
 * Single Bun event-loop safe: all file I/O is async (readFile); NO sync fs calls.
 * Pattern mirrors src/activity-signal.ts (async poll + byte-offset cursor).
 */

import { readFile as nodeReadFile } from "node:fs/promises";
import { hostMatchesAllowlist } from "./egress";

/** Maximum distinct blocked hosts reported per session before the watcher silences itself. */
export const EGRESS_DROP_CAP = 20;

/** Default polling interval in ms. */
const EGRESS_WATCH_INTERVAL_MS = 2_000;

// ── regex ──────────────────────────────────────────────────────────────────────
// dnsmasq query line format (one example):
//   Jun 12 10:23:45 dnsmasq[12345]: query[A] api.anthropic.com from 127.0.0.1
// We match: "query[<type>] <host> from"
const QUERY_RE = /\bquery\[[^\]]+\]\s+(\S+)\s+from\b/;

// ── injectable deps ────────────────────────────────────────────────────────────

export interface EgressWatcherDeps {
  /** Async file reader; default is node:fs/promises readFile (utf8). */
  readFile?: (path: string) => Promise<string>;
  /** Store addSignal sink. */
  addSignal: (input: {
    repoPath: string;
    sessionId: string;
    kind: "egress_drop";
    payload: string;
  }) => void;
  /** EventHub emit; absent in tests that skip UI push. */
  emit?: (event: string, data: unknown) => void;
  /** Polling interval in ms; default EGRESS_WATCH_INTERVAL_MS. */
  intervalMs?: number;
  /** setInterval seam; default global setInterval. */
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  /** clearInterval seam; default global clearInterval. */
  clearInterval?: (id: ReturnType<typeof setInterval>) => void;
}

// ── per-session state ──────────────────────────────────────────────────────────

interface SessionState {
  interval: ReturnType<typeof setInterval>;
  /** Byte offset into dns.log — only new bytes are processed each tick. */
  cursor: number;
  /** Hosts already reported for this session (deduplication). */
  reported: Set<string>;
  /** Drop the watcher after the cap is reached. */
  capped: boolean;
}

// ── helpers ────────────────────────────────────────────────────────────────────

/**
 * Parse one dnsmasq log line and return the queried hostname (lowercased),
 * or null if the line is not a query line.
 */
function extractQueriedHost(line: string): string | null {
  const m = QUERY_RE.exec(line);
  return m ? m[1]!.toLowerCase() : null;
}

// ── EgressWatcher ──────────────────────────────────────────────────────────────

export class EgressWatcher {
  private readonly deps: Required<
    Pick<
      EgressWatcherDeps,
      "readFile" | "addSignal" | "intervalMs" | "setInterval" | "clearInterval"
    >
  > & { emit?: (event: string, data: unknown) => void };

  private readonly sessions = new Map<string, SessionState>();

  constructor(deps: EgressWatcherDeps) {
    this.deps = {
      readFile: deps.readFile ?? ((p) => nodeReadFile(p, "utf8")),
      addSignal: deps.addSignal,
      emit: deps.emit,
      intervalMs: deps.intervalMs ?? EGRESS_WATCH_INTERVAL_MS,
      setInterval: deps.setInterval ?? ((...args) => setInterval(...args)),
      clearInterval: deps.clearInterval ?? ((...args) => clearInterval(...args)),
    };
  }

  /**
   * Start watching `dnsLogPath` for `sessionId`. Idempotent — a duplicate start
   * for the same id is a no-op (existing watcher preserved).
   */
  start(
    sessionId: string,
    opts: {
      repoPath: string;
      dnsLogPath: string;
      allowlist: string[];
    },
  ): void {
    if (this.sessions.has(sessionId)) return; // already watching

    const tick = () => this.#tick(sessionId, opts);
    const interval = this.deps.setInterval(tick, this.deps.intervalMs);
    this.sessions.set(sessionId, { interval, cursor: 0, reported: new Set(), capped: false });
  }

  /**
   * Stop watching `sessionId` and drop all per-session state. Idempotent.
   */
  stop(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.deps.clearInterval(state.interval);
    this.sessions.delete(sessionId);
  }

  /** Stop all active watchers (shutdown). */
  stopAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.stop(id);
    }
  }

  // ── internal ─────────────────────────────────────────────────────────────────

  /**
   * Single poll tick: read new bytes from dns.log, parse query lines, emit drops.
   * All errors are swallowed so a bad log never throws out of the timer.
   *
   * Exposed as a public method so tests can call it directly (no real timers).
   */
  async tick(
    sessionId: string,
    opts: { repoPath: string; dnsLogPath: string; allowlist: string[] },
  ): Promise<void> {
    return this.#tick(sessionId, opts);
  }

  /**
   * Report one dropped host: add signal + emit UI event.
   * Returns true if the cap was reached after this report.
   */
  #reportDroppedHost(
    host: string,
    sessionId: string,
    state: SessionState,
    opts: { repoPath: string; allowlist: string[] },
  ): boolean {
    if (state.reported.has(host)) return false;
    state.reported.add(host);

    try {
      this.deps.addSignal({
        repoPath: opts.repoPath,
        sessionId,
        kind: "egress_drop",
        payload: host,
      });
      this.deps.emit?.("session:egress-drop", { id: sessionId, host });
    } catch {
      // Never let a signal-store error propagate.
    }

    return state.reported.size >= EGRESS_DROP_CAP;
  }

  async #tick(
    sessionId: string,
    opts: { repoPath: string; dnsLogPath: string; allowlist: string[] },
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || state.capped) return;

    let content: string;
    try {
      content = await this.deps.readFile(opts.dnsLogPath);
    } catch (err: unknown) {
      // ENOENT is expected while dnsmasq hasn't written its first line yet — ignore.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // Any other read error is also silently swallowed per spec.
      }
      return;
    }

    // Only process newly appended bytes (cursor is a char offset here; for utf8
    // log lines — ASCII-safe — byte offset equals char offset in Node's readFile).
    const tail = content.slice(state.cursor);
    state.cursor = content.length;

    if (!tail) return;

    for (const line of tail.split("\n")) {
      if (state.capped) break;

      const host = extractQueriedHost(line);
      if (!host) continue;

      // Skip allowlisted hosts — they're expected.
      if (hostMatchesAllowlist(host, opts.allowlist)) continue;

      if (this.#reportDroppedHost(host, sessionId, state, opts)) {
        state.capped = true;
        break;
      }
    }
  }
}
