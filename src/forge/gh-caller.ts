/**
 * Who made a GitHub call (#2743). A label set with {@link withGhCaller} follows the async work it
 * starts (awaits, timers, intervals), so wrapping a poller's `start()` or an HTTP request labels
 * every `gh` call made under it. The shared runner tallies calls and points per label.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** The label of a call made outside any {@link withGhCaller} — its share shows a missing label. */
export const UNATTRIBUTED = "unattributed";

const caller = new AsyncLocalStorage<string>();

/** Run `fn` with GitHub calls attributed to `label`. */
export function withGhCaller<T>(label: string, fn: () => T): T {
  return caller.run(label, fn);
}

/** Label the rest of the current scope — the timers and intervals it goes on to create. Only
 *  inside a {@link withGhCaller} scope (the boot runs each deferred start in its own), so the
 *  label can't leak into code that runs after the scope. */
export function labelGhCalls(label: string): void {
  caller.enterWith(label);
}

/** The label of the code running now. */
export function currentGhCaller(): string {
  return caller.getStore() ?? UNATTRIBUTED;
}

/** A path segment that names one thing (number, uuid, hex id) rather than a route. */
const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,})$/i;

/** The label of an HTTP request: method + path, with id segments collapsed to `:id`. */
export function routeCaller(method: string, pathname: string): string {
  const path = pathname
    .split("/")
    .map((seg) => (ID_SEGMENT.test(seg) ? ":id" : seg))
    .join("/");
  return `http:${method} ${path}`;
}
