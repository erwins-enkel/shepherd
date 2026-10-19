/**
 * Coalesce concurrent calls onto a single in-flight run.
 *
 * The returned function starts `fn` on the first call and hands every caller that arrives while it
 * is still running the SAME promise — so they all await the one real run and share its result,
 * rather than each kicking off (or short-circuiting past) their own. Once the run settles the slot
 * clears, so the next call starts a fresh run.
 *
 * Used to guard the `/usage` probe: a manual refresh that lands while a scheduled calibrate is in
 * flight awaits that scrape's completed result instead of returning the stale pre-scrape snapshot,
 * while still never double-spawning the ephemeral probe agent.
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inflight: Promise<T> | null = null;
  return () => (inflight ??= fn().finally(() => (inflight = null)));
}

/**
 * {@link singleFlight} per key: concurrent calls with the SAME key share one in-flight run, calls
 * with different keys run independently. A key's slot clears once its run settles.
 *
 * Used for the Operator Assistant's lifecycle, one slot per scope (null = the global assistant).
 */
export function keyedSingleFlight<K, T>(fn: (key: K) => Promise<T>): (key: K) => Promise<T> {
  const inflight = new Map<K, Promise<T>>();
  return (key) => {
    let run = inflight.get(key);
    if (!run) {
      run = fn(key).finally(() => inflight.delete(key));
      inflight.set(key, run);
    }
    return run;
  };
}
