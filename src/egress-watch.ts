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
  // Read-only: "r" never creates the file, so the mode is inert. Explicit owner-only mode anyway, so
  // CodeQL js/insecure-temporary-file (alert #33, which models any mode-less open as a creation)
  // sees no world-readable create.
  const fh = await open(path, "r", 0o600);
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

/** Characters a hostname may carry into the agent note (the DNS log is agent-influenced). */
const NOTE_HOST_UNSAFE = /[^a-z0-9._-]/g;
const MAX_NOTE_HOST_CHARS = 253;

/** The note that tells the agent a host was blocked (#3921) — single source for the hook and
 *  steer channels. Agent-facing English, like Shepherd's other directives. */
export function egressBlockedNote(host: string): string {
  const safe = host.toLowerCase().replace(NOTE_HOST_UNSAFE, "").slice(0, MAX_NOTE_HOST_CHARS);
  return (
    `Shepherd: egress to ${safe} was blocked by the sandbox allowlist (autonomous egress ` +
    "firewall). This is not a network fault. Don't retry or work around it. Tell the operator " +
    "the host must be allowed (repo settings → Agent environment → Extra allowed hosts)."
  );
}

/** How a session's agent hears about a block: queued for its next tool hook reply, or steered. */
export type EgressNoteChannel = "hook" | "steer";

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
  /** Steer-channel delivery of the blocked-host note (#3921); absent ⇒ steer notes are dropped. */
  steer?: (sessionId: string, text: string) => Promise<unknown>;
  /** Polling interval in ms; default EGRESS_WATCH_INTERVAL_MS. */
  intervalMs?: number;
  /** setInterval seam; default global setInterval. */
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  /** clearInterval seam; default global clearInterval. */
  clearInterval?: (id: ReturnType<typeof setInterval>) => void;
}

// ── per-session state ──────────────────────────────────────────────────────────

interface WatchOpts {
  repoPath: string;
  dnsLogPath: string;
  allowlist: string[];
}

interface SessionState {
  interval: ReturnType<typeof setInterval>;
  /** The start opts, so `flush` can run a tick without the caller knowing them. */
  opts: WatchOpts;
  /** Where blocked-host notes go (#3921). */
  noteChannel: EgressNoteChannel;
  /** Hook-channel notes not yet handed to the agent. */
  pending: string[];
  /** Tail of the tick chain: ticks run one at a time so a forced flush never races the timer
   *  on `cursor` / `partial`. */
  inflight: Promise<void> | null;
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
  > & {
    emit?: (event: string, data: unknown) => void;
    steer?: (sessionId: string, text: string) => Promise<unknown>;
  };

  private readonly sessions = new Map<string, SessionState>();

  constructor(deps: EgressWatcherDeps) {
    this.deps = {
      readTail: deps.readTail ?? defaultReadTail,
      addSignal: deps.addSignal,
      emit: deps.emit,
      steer: deps.steer,
      intervalMs: deps.intervalMs ?? EGRESS_WATCH_INTERVAL_MS,
      setInterval: deps.setInterval ?? ((...args) => setInterval(...args)),
      clearInterval: deps.clearInterval ?? ((...args) => clearInterval(...args)),
    };
  }

  /**
   * Start watching `dnsLogPath` for `sessionId`. Idempotent — a duplicate start
   * for the same id is a no-op (existing watcher preserved).
   */
  start(sessionId: string, opts: WatchOpts & { noteChannel?: EgressNoteChannel }): void {
    if (this.sessions.has(sessionId)) return; // already watching

    // `void`: #tick swallows all its own errors (see its doc), and the timer callback is
    // `() => void` — returning the promise would be a misused-promises violation, not a handler.
    const tick = () => void this.#serialTick(sessionId, opts);
    const interval = this.deps.setInterval(tick, this.deps.intervalMs);
    this.sessions.set(sessionId, {
      interval,
      opts,
      noteChannel: opts.noteChannel ?? "hook",
      pending: [],
      inflight: null,
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

  /** Run one tick now (after any in-flight one), so a hook reply sees a block that happened
   *  moments ago. No-op for an unknown session. */
  async flush(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state) await this.#serialTick(sessionId, state.opts);
  }

  /** Drain the session's queued hook-channel notes as one block, or null when none. */
  takeNotes(sessionId: string): string | null {
    const state = this.sessions.get(sessionId);
    if (!state || state.pending.length === 0) return null;
    const text = state.pending.join("\n");
    state.pending = [];
    return text;
  }

  /** Hosts blocked so far in this session (capped), or null when it has no egress watcher. */
  blockedHosts(sessionId: string): string[] | null {
    const state = this.sessions.get(sessionId);
    return state ? [...state.reported] : null;
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
  async tick(sessionId: string, opts: WatchOpts): Promise<void> {
    return this.#serialTick(sessionId, opts);
  }

  /** Queue a tick behind the session's in-flight one, so ticks never overlap. */
  #serialTick(sessionId: string, opts: WatchOpts): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return Promise.resolve();
    const next = (state.inflight ?? Promise.resolve()).then(() => this.#tick(sessionId, opts));
    state.inflight = next;
    const clear = () => {
      if (state.inflight === next) state.inflight = null;
    };
    next.then(clear, clear);
    return next;
  }

  /**
   * Report one dropped host: add signal + emit UI event + tell the agent (#3921).
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
    this.#noteAgent(sessionId, state, host);

    return state.reported.size >= EGRESS_DROP_CAP;
  }

  /** Hand the blocked-host note to the agent: queued for the next tool hook, or steered. */
  #noteAgent(sessionId: string, state: SessionState, host: string): void {
    const note = egressBlockedNote(host);
    if (state.noteChannel === "hook") {
      state.pending.push(note);
      return;
    }
    const steer = this.deps.steer;
    if (!steer) return;
    // Best-effort: a dead pane, shelved session or capacity gate drops it.
    void Promise.resolve()
      .then(() => steer(sessionId, note))
      .catch(() => {});
  }

  async #tick(sessionId: string, opts: WatchOpts): Promise<void> {
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
