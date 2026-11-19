/** Shared timing primitives (#4077): one home for sleeps, timeouts and the backoff formula. */

/** Resolves after `ms`. `unref`: the timer never keeps the process alive. */
export function sleep(ms: number, opts?: { unref?: boolean }): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (opts?.unref) timer.unref?.();
  });
}

/** `p`, or `onTimeout()` once `ms` passes first; `onTimeout` throwing rejects instead. The timer
 *  never keeps the process alive and is cleared as soon as either side settles. */
export function withTimeout<T, F = T>(
  p: PromiseLike<T>,
  ms: number,
  onTimeout: () => F,
): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<F>((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        resolve(onTimeout());
      } catch (err) {
        reject(err);
      }
    }, ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Exponential backoff: `baseMs` doubled per attempt past the first, capped at `maxMs` (default
 *  uncapped). `attempt` is 1-based; anything below 1 clamps to `baseMs`. Pure, so callers with their
 *  own loops or schedulers share the formula. */
export function backoffDelay(attempt: number, opts: { baseMs: number; maxMs?: number }): number {
  const exp = Math.max(0, attempt - 1);
  return Math.min(opts.baseMs * 2 ** exp, opts.maxMs ?? Infinity);
}
