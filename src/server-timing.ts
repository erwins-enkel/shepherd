/**
 * `Server-Timing` for API responses — lets a client split a slow request into "network" and
 * "server" without access to the server's logs (the native iOS latency indicator reads it).
 *
 * Two metrics, both in milliseconds:
 *  - `app` — wall time the request spent inside the route handlers (makeApp's dispatch).
 *  - `lag` — the worst event-loop stall seen in the last {@link LAG_WINDOW_MS}, including one still
 *    in progress. Needed because `app` alone lies about the commonest kind of slowness here: while
 *    the single Bun loop is blocked by a synchronous call, an arriving request waits *before* its
 *    handler starts, so `app` stays tiny and the client would blame the network for a stall that is
 *    entirely the server's.
 *
 * The lag sampler is one unref'd interval timer — started by `serve()` only, so unit tests that
 * build `makeApp` directly get `app` alone and no timer.
 */

const SAMPLE_MS = 250;
const BUCKET_MS = 5_000;
export const LAG_WINDOW_MS = 60_000;
const BUCKETS = LAG_WINDOW_MS / BUCKET_MS;

/** Rolling max of event-loop lag in fixed buckets. Pure — the clock is passed in. */
export class LoopLagWindow {
  private readonly maxima = new Array<number>(BUCKETS).fill(0);
  private readonly stamps = new Array<number>(BUCKETS).fill(-1);
  private lastTick: number;

  constructor(
    now: number,
    private readonly sampleMs = SAMPLE_MS,
  ) {
    this.lastTick = now;
  }

  /** Called from the sampler timer: records how late this tick fired. */
  tick(now: number): void {
    const lag = Math.max(0, now - this.lastTick - this.sampleMs);
    this.lastTick = now;
    const bucket = Math.floor(now / BUCKET_MS);
    const slot = bucket % BUCKETS;
    if (this.stamps[slot] !== bucket) {
      this.stamps[slot] = bucket;
      this.maxima[slot] = 0;
    }
    this.maxima[slot] = Math.max(this.maxima[slot]!, lag);
  }

  /** Worst lag in the window, counting a stall the sampler has not yet had a chance to record
   *  (a request that queued behind a block can run before the overdue timer does). */
  maxLag(now: number): number {
    const oldest = Math.floor((now - LAG_WINDOW_MS) / BUCKET_MS);
    let max = Math.max(0, now - this.lastTick - this.sampleMs);
    for (let i = 0; i < BUCKETS; i++) {
      if (this.stamps[i]! > oldest) max = Math.max(max, this.maxima[i]!);
    }
    return max;
  }
}

let lagWindow: LoopLagWindow | null = null;

/** Start the lag sampler. Idempotent; returns a stop function (tests). */
export function startLoopLagMonitor(): () => void {
  if (lagWindow) return () => {};
  const w = new LoopLagWindow(performance.now());
  lagWindow = w;
  const id = setInterval(() => w.tick(performance.now()), SAMPLE_MS);
  id.unref?.();
  return () => {
    clearInterval(id);
    if (lagWindow === w) lagWindow = null;
  };
}

/** The header value: `app;dur=<ms>` plus `lag;dur=<ms>` once the sampler runs. */
export function serverTimingValue(appMs: number, lagMs: number | null = currentLoopLag()): string {
  const app = `app;dur=${appMs.toFixed(1)}`;
  return lagMs === null ? app : `${app}, lag;dur=${Math.round(lagMs)}`;
}

export function currentLoopLag(): number | null {
  return lagWindow ? lagWindow.maxLag(performance.now()) : null;
}

/** Stamp the header on an API response. A response with immutable headers (e.g. a
 *  `Response.redirect`) is returned untouched — timing is a hint, never a failure. */
export function withServerTiming(res: Response, appMs: number): Response {
  try {
    res.headers.set("Server-Timing", serverTimingValue(appMs));
  } catch {
    /* immutable headers — skip */
  }
  return res;
}
