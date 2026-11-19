/**
 * Shared result type for fallible functions (#4079).
 *
 * House convention: new fallible pure functions return {@link Result} (built with {@link ok} /
 * {@link err}) instead of inventing their own `{ ok: true … } | { ok: false … }` union. Narrow on
 * `.ok`. Existing ad-hoc unions switch over only when their module is touched for other reasons —
 * no big-bang migration. Keep this module minimal: add a combinator only when a real call site
 * needs it.
 */

/** Success carrying `value`, or failure carrying `error` (a message string unless `E` says otherwise). */
export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

/** The success variant of a {@link Result}. */
export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

/** The failure variant of a {@link Result}. */
export function err<E>(error: E): { ok: false; error: E } {
  return { ok: false, error };
}
