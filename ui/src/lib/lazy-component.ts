/**
 * On-demand loading for components that are not on the first screen (#3233).
 *
 * `lazy()` wraps a dynamic `import()` so every caller shares one in-flight/resolved promise. A
 * rejected load (dropped chunk, or a deploy that moved the hashes) is forgotten, so the next
 * open retries instead of replaying the cached failure.
 */
export type Loader<T> = () => Promise<{ default: T }>;

export function lazy<T>(loader: Loader<T>): Loader<T> {
  let pending: Promise<{ default: T }> | null = null;
  return () => {
    if (!pending) {
      const p = loader();
      pending = p;
      p.catch(() => {
        if (pending === p) pending = null;
      });
    }
    return pending;
  };
}

type Schedule = (cb: () => void) => void;

const whenIdle: Schedule = (cb) => {
  if (typeof requestIdleCallback === "function") requestIdleCallback(cb);
  else setTimeout(cb, 2000);
};

/** Warm the module cache for likely-next components once the boot has settled. */
export function prefetchWhenIdle(loaders: Loader<unknown>[], schedule: Schedule = whenIdle): void {
  schedule(() => {
    for (const load of loaders) load().catch(() => {});
  });
}
