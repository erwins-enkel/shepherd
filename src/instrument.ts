/**
 * Profiling / instrumentation helpers — zero-cost when SHEPHERD_PROFILE_LOOP is unset.
 * Set SHEPHERD_PROFILE_LOOP=1 to enable event-loop-lag sampling and per-call timing.
 */
import {
  execFileSync as _execFileSync,
  type ExecFileSyncOptionsWithStringEncoding,
  type ExecFileSyncOptionsWithBufferEncoding,
  type ExecFileSyncOptions,
} from "node:child_process";
import { readFileSync as _readFileSync } from "node:fs";
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

function execLabel(file: string, args?: readonly string[]): string {
  const sub = args?.[0];
  return sub ? `${file} ${sub}` : file;
}

// Overloads mirror node:child_process execFileSync's primary call signatures.
export function execFileSync(
  file: string,
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding,
): string;
export function execFileSync(
  file: string,
  args?: readonly string[],
  options?: ExecFileSyncOptionsWithBufferEncoding | ExecFileSyncOptions,
): Buffer;
export function execFileSync(
  file: string,
  args?: readonly string[],
  options?:
    | ExecFileSyncOptionsWithStringEncoding
    | ExecFileSyncOptionsWithBufferEncoding
    | ExecFileSyncOptions,
): string | Buffer {
  const label = execLabel(file, args);
  return timed(
    label,
    () => _execFileSync(file, args as string[], options as ExecFileSyncOptions) as string | Buffer,
  );
}

// ── readFileSync passthrough ──────────────────────────────────────────────────

/**
 * Drop-in for `readFileSync(path, "utf8")` — the pattern used in transcript hot paths.
 * Wraps in `timed` with label `readFileSync <basename>`.
 */
export function readFileSync(path: string, encoding: "utf8" | BufferEncoding): string {
  return timed(`readFileSync ${basename(path)}`, () => _readFileSync(path, encoding as "utf8"));
}
