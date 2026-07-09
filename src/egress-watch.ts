/**
 * Per-session DNS-drop watcher: tails the dnsmasq dns.log written by egress-runner.sh
 * and surfaces blocked-host attempts as operator-visible signals + UI events.
 *
 * Single Bun event-loop safe: all file I/O is async; NO sync fs calls. Each poll
 * reads ONLY the bytes appended since the last tick (positional read from the
 * cursor), so a long all-allowlisted session does not re-read a growing log every
 * tick — cost is O(appended), not O(filesize). Mirrors src/activity-signal.ts.
 */

import { open } from "node:fs/promises";
import { hostMatchesAllowlist } from "./egress";

/**
 * Read the appended tail of `path` from byte `fromByte` to EOF, returning the new
 * bytes + the file's current size. Reads only [fromByte, size) — never the whole
 * file. On truncation/rotation (size < fromByte) it re-reads from 0. (Log is ASCII,
 * so a utf8 multibyte char can't straddle the read boundary in practice.)
 */
async function defaultReadTail(
  path: string,
  fromByte: number,
): Promise<{ data: string; size: number }> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const start = fromByte <= size ? fromByte : 0; // truncation/rotation → reread from 0
    if (size <= start) return { data: "", size };
    const buf = Buffer.allocUnsafe(size - start);
    await fh.read(buf, 0, size - start, start);
    return { data: buf.toString("utf8"), size };
  } finally {
    await fh.close();
  }
}

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
  /** Positional tail reader: returns bytes appended since `fromByte` + the current
   *  file size. Default reads only the appended slice (not the whole file). */
  readTail?: (path: string, fromByte: number) => Promise<{ data: string; size: number }>;
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
  /** Byte offset into dns.log — only new bytes are read each tick. */
  cursor: number;
  /** Trailing bytes after the last newline of the previous read — a line caught
   *  mid-write. Prepended to the next read so a query line split across a poll
   *  boundary is reassembled and reported exactly. */
  partial: string;
  /** Hosts already reported for this session (deduplication). */
  reported: Set<string>;
  /** Drop the watcher after the cap is reached. */
  capped: boolean;
}

/** Safety bound on a buffered partial line so a never-terminated line can't grow
 *  unbounded (dnsmasq lines are short + newline-terminated; this never trips normally). */
const MAX_PARTIAL_BYTES = 64 * 1024;

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
      "readTail" | "addSignal" | "intervalMs" | "setInterval" | "clearInterval"
    >
  > & { emit?: (event: string, data: unknown) => void };

  private readonly sessions = new Map<string, SessionState>();

  constructor(deps: EgressWatcherDeps) {
    this.deps = {
      readTail: deps.readTail ?? defaultReadTail,
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

    // `void`: #tick swallows all its own errors (see its doc), and the timer callback is
    // `() => void` — returning the promise would be a misused-promises violation, not a handler.
    const tick = () => void this.#tick(sessionId, opts);
    const interval = this.deps.setInterval(tick, this.deps.intervalMs);
    this.sessions.set(sessionId, {
      interval,
      cursor: 0,
      partial: "",
      reported: new Set(),
      capped: false,
    });
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

    // Read ONLY the bytes appended since the last tick (positional read from the
    // cursor) — never the whole growing log. ENOENT (dnsmasq hasn't written yet) and
    // any other read error are swallowed (best-effort observability).
    let res: { data: string; size: number };
    try {
      res = await this.deps.readTail(opts.dnsLogPath, state.cursor);
    } catch {
      return;
    }
    state.cursor = res.size;

    // Reassemble across poll boundaries: a line caught mid-write last tick is
    // buffered in `partial` and completed by this read. Process only COMPLETE lines
    // (up to the last newline); re-buffer the trailing partial for the next tick so
    // no split query line is dropped. (Real dnsmasq output is newline-terminated, so
    // in the common case `partial` ends empty and every line is processed at once.)
    const combined = state.partial + res.data;
    const lastNl = combined.lastIndexOf("\n");
    if (lastNl === -1) {
      // No complete line yet — buffer everything (bounded) and wait for a newline.
      state.partial = combined.length > MAX_PARTIAL_BYTES ? "" : combined;
      return;
    }
    state.partial = combined.slice(lastNl + 1);
    const complete = combined.slice(0, lastNl);

    for (const line of complete.split("\n")) {
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
