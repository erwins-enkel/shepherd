/** TEST-ONLY helper for browser tests (which are plain .ts and cannot use runes).
 *
 *  Returns a deeply-reactive `$state` record to pass AS a prop value. Mutating it
 *  from the test (set/delete keys) notifies the component fine-grained — unlike the
 *  harness's `rerender`, which replaces the whole `$state.raw` props object and
 *  therefore invalidates EVERY prop read (re-running e.g. repo-change reset effects
 *  that a single-prop update would never touch in production). */
export function reactiveRecord<T>(initial: Record<string, T>): Record<string, T> {
  const value = $state(initial);
  return value;
}
