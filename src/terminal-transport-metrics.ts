/**
 * Per-boot counters for the herdr-native socket terminal transport, plus a
 * one-shot self-check that warns when the socket path silently and uniformly
 * falls back to node-pty (i.e. the socket never once attached, but fallbacks
 * did occur). Neither `instrument.ts` (profiling no-op unless
 * SHEPHERD_PROFILE_LOOP=1) nor `DiagnosticsService` (strict-payload prober)
 * can carry these counts, hence this dedicated module.
 */

export interface TerminalTransportMetrics {
  /** Confirmed socket-terminal attaches this boot. */
  socketAttach: number;
  /** Times the socket path fell back to node-pty this boot. */
  socketFallback: number;
  lastSocketAttachAt: number | null;
}

function initialMetrics(): TerminalTransportMetrics {
  return { socketAttach: 0, socketFallback: 0, lastSocketAttachAt: null };
}

let state: TerminalTransportMetrics = initialMetrics();

/** Record a confirmed socket-terminal attach (called on the first terminal.frame). */
export function recordSocketAttach(now: number = Date.now()): void {
  state.socketAttach += 1;
  state.lastSocketAttachAt = now;
}

/** Record a socket-path fallback to node-pty. */
export function recordFallback(): void {
  state.socketFallback += 1;
}

/** A snapshot COPY of the current counters (mutating the result must not affect internals). */
export function terminalTransportMetrics(): TerminalTransportMetrics {
  return { ...state };
}

/** Test-only reset of the per-boot counters. */
export function __resetTerminalTransportMetrics(): void {
  state = initialMetrics();
}

/**
 * Pure predicate: true when the socket flag is active but not a single socket
 * attach has happened while fallbacks HAVE occurred — i.e. a likely
 * uniformly-broken socket path.
 */
export function shouldWarnSilentFallback(
  flagActive: boolean,
  m: TerminalTransportMetrics = terminalTransportMetrics(),
): boolean {
  if (!flagActive) return false;
  return m.socketAttach === 0 && m.socketFallback > 0;
}

const DEFAULT_GRACE_MS = 5 * 60_000;

function defaultSchedule(fn: () => void, ms: number): { stop: () => void } {
  const id = setTimeout(fn, ms);
  id.unref?.();
  return { stop: () => clearTimeout(id) };
}

/**
 * Schedule a one-shot self-check `graceMs` after boot: if
 * shouldWarnSilentFallback(...) then `warn(...)` once with a structured
 * message. No-op (schedules nothing) when flagActive is false. Returns a
 * stop() that cancels a pending check. The default scheduler uses an
 * unref'd setTimeout so it never holds the process open.
 */
export function startTerminalTransportSelfCheck(
  flagActive: boolean,
  opts?: {
    graceMs?: number;
    warn?: (msg: string) => void;
    schedule?: (fn: () => void, ms: number) => { stop: () => void };
  },
): () => void {
  if (!flagActive) return () => {};

  const graceMs = opts?.graceMs ?? DEFAULT_GRACE_MS;
  const warn = opts?.warn ?? console.warn;
  const schedule = opts?.schedule ?? defaultSchedule;

  const handle = schedule(() => {
    const m = terminalTransportMetrics();
    if (shouldWarnSilentFallback(flagActive, m)) {
      warn(
        `[herdr] socket terminal never engaged (${m.socketFallback} fallbacks, 0 socket-attach) — check 'terminal session control' support`,
      );
    }
  }, graceMs);

  return () => handle.stop();
}
