/**
 * Profiling / instrumentation helpers — zero-cost when SHEPHERD_PROFILE_LOOP is unset.
 * Set SHEPHERD_PROFILE_LOOP=1 to enable event-loop-lag sampling and per-call timing.
 */
import { execFileSync as nodeExecFileSync } from "node:child_process";
import { readFileSync as nodeReadFileSync } from "node:fs";
import { basename } from "node:path";

/** Lazy — read inside each function so tests can toggle the env var. */
const isProfiling = () => process.env.SHEPHERD_PROFILE_LOOP === "1";

const LAG_THRESHOLD_MS = 150;
const TIMED_THRESHOLD_MS = 250;

// ── loop-lag sampler ──────────────────────────────────────────────────────────

/**
 * Schedule a repeating timer that measures the gap between expected and actual
 * fire time. Logs `[profile] loop-lag <N>ms` when the lag exceeds 150ms.
 * Returns a stop function. No-op (no timer, no-op stop) when profiling is off.
 */
export function startLoopLagSampler(): () => void {
  if (!isProfiling()) return () => {};
  const INTERVAL = 50;
  let last = Date.now();
  const id = setInterval(() => {
    const now = Date.now();
    const lag = now - last - INTERVAL;
    last = now;
    if (lag > LAG_THRESHOLD_MS) {
      console.warn(`[profile] loop-lag ${lag}ms`);
    }
  }, INTERVAL);
  id.unref();
  return () => clearInterval(id);
}

// ── synchronous timed wrapper ─────────────────────────────────────────────────

/**
 * Wrap a synchronous function with wall-time measurement.
 * Logs `[profile] <label> <N>ms` when over 250ms. Always returns/re-throws as-is.
 * When profiling is off, calls fn() directly with zero overhead.
 */
export function timed<T>(label: string, fn: () => T): T {
  if (!isProfiling()) return fn();
  const start = Date.now();
  let threw = false;
  let err: unknown;
  let result: T;
  try {
    result = fn();
  } catch (e) {
    threw = true;
    err = e;
    result = undefined as unknown as T;
  }
  const ms = Date.now() - start;
  if (ms > TIMED_THRESHOLD_MS) {
    console.warn(`[profile] ${label} ${ms}ms`);
  }
  if (threw) throw err;
  return result;
}

// ── async timed wrapper ───────────────────────────────────────────────────────

/**
 * Wrap an async function with wall-time measurement.
 * Same threshold/log behavior as `timed`. When off, awaits fn() directly.
 */
export async function timedAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!isProfiling()) return fn();
  const start = Date.now();
  let threw = false;
  let err: unknown;
  let result: T;
  try {
    result = await fn();
  } catch (e) {
    threw = true;
    err = e;
    result = undefined as unknown as T;
  }
  const ms = Date.now() - start;
  if (ms > TIMED_THRESHOLD_MS) {
    console.warn(`[profile] ${label} ${ms}ms`);
  }
  if (threw) throw err;
  return result;
}

// ── execFileSync passthrough ──────────────────────────────────────────────────

export const execFileSync: typeof nodeExecFileSync = ((
  ...args: Parameters<typeof nodeExecFileSync>
) => {
  const [file, second] = args;
  const sub = Array.isArray(second) ? (second as string[])[0] : undefined;
  const label = sub ? `${String(file)} ${sub}` : String(file);
  return timed(label, () => nodeExecFileSync(...(args as Parameters<typeof nodeExecFileSync>)));
}) as typeof nodeExecFileSync;

// ── startup blocker map ───────────────────────────────────────────────────────

/**
 * Emit a one-time operator map of sync calls intentionally left on the event
 * loop (local/fast). Called once at startup regardless of the profile flag.
 */
export function logRemainingOnLoopBlockers(): void {
  console.info(
    "[shepherd] on-loop sync calls remaining (local/fast, instrumented):" +
      " herdr list/read (local daemon IPC)," +
      " local git in branch-pruner/repos/branches/worktree/plan-gate/review," +
      " herdr --version (herdr-update)," +
      " git remote get-url (forge/index, backlog)," +
      " process-reaper counter-command.",
  );
}

// ── PTY event gap tracker ─────────────────────────────────────────────────────

let _lastPtyEventTime = 0;

/**
 * Record a PTY I/O event and log the wall-clock gap since the previous one.
 * Logs `[profile] pty-gap <label> <N>ms` when the gap exceeds 150ms.
 * No-op when profiling is off. Input and output events share one timeline so
 * a large gap pinpoints where the loop was blocked.
 *
 * NOTE: `_lastPtyEventTime` is a single shared timestamp across **all**
 * concurrent PtyBridge instances (one per open terminal). That's intentional —
 * it gives a loop-wide view good enough to spot broad stalls. The trade-off is
 * that activity on terminal A resets the clock and can mask a gap on terminal B;
 * for per-terminal accuracy you'd need a per-instance marker.
 */
export function markPtyEvent(label: string): void {
  if (!isProfiling()) return;
  const now = Date.now();
  if (_lastPtyEventTime !== 0) {
    const gap = now - _lastPtyEventTime;
    if (gap > LAG_THRESHOLD_MS) {
      console.warn(`[profile] pty-gap ${label} ${gap}ms`);
    }
  }
  _lastPtyEventTime = now;
}

// ── readFileSync passthrough ──────────────────────────────────────────────────

/**
 * Faithful passthrough for node's `readFileSync`. Wraps in `timed` with label
 * `readFileSync <basename>` (basename derived only when the first arg is a string).
 */
export const readFileSync: typeof nodeReadFileSync = ((
  ...args: Parameters<typeof nodeReadFileSync>
) => {
  const first = args[0];
  const name = typeof first === "string" ? basename(first) : "readFileSync";
  return timed(`readFileSync ${name}`, () =>
    nodeReadFileSync(...(args as Parameters<typeof nodeReadFileSync>)),
  );
}) as typeof nodeReadFileSync;
