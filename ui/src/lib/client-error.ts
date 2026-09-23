/**
 * Classification for unexpected CLIENT-side errors, feeding `hooks.client.ts` + `+error.svelte`.
 *
 * Why this exists: SvelteKit renders its own unstyled fallback — a bare `500` / `Internal Error`
 * in monospace, with no app chrome and no way back — for any thrown value that is not an
 * `HttpError`:
 *
 *   status(e) => e instanceof HttpError || e instanceof Redirect ? e.status : 500
 *   text(e)   => e instanceof HttpError ? e.text : "Internal Error"
 *
 * In a prerendered SPA (`ssr = false`) the overwhelmingly common trigger is a failed dynamic
 * `import()` of a route chunk: the shell is already painted, then the network drops the chunk
 * request. That is a transport failure, not a bug in the app, and it deserves "retry" rather than
 * a dead end. Each engine words that failure differently, so match every phrasing rather than
 * whichever one the developer's browser happens to emit.
 */

/** `chunk` = a route/asset chunk never arrived (retryable); `unknown` = a genuine app error. */
export type ClientErrorKind = "chunk" | "unknown";

/**
 * Lowercased needles for a failed dynamic import / asset preload, one per engine. Kept as
 * substrings because the surrounding text carries the (unstable) chunk URL.
 */
const CHUNK_PATTERNS = [
  "failed to fetch dynamically imported module", // Chromium
  "error loading dynamically imported module", // Firefox
  "importing a module script failed", // Safari / WebKit
  "unable to preload css", // SvelteKit's own preload path
] as const;

/** Flatten any thrown value to searchable text without assuming it is an `Error`. */
export function errorText(error: unknown): string {
  if (error == null) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

/** True when the thrown value is a failed chunk/asset fetch rather than an app-logic fault. */
export function classifyClientError(error: unknown): ClientErrorKind {
  const text = errorText(error).toLowerCase();
  return CHUNK_PATTERNS.some((pattern) => text.includes(pattern)) ? "chunk" : "unknown";
}

/**
 * Session-scoped guard for the one-shot reload the error page performs on a `chunk` error.
 *
 * A chunk can go missing for two very different reasons, and one reload distinguishes them:
 *   - the deploy moved (`bun run update` rewrites every hashed chunk) — the reload fetches the new
 *     manifest and the app comes back permanently;
 *   - the link is flaky — the reload probably fails too.
 *
 * So: reload at most ONCE per tab, then fall through to the error page rather than looping on a
 * connection that cannot serve the app. `sessionStorage` (not `localStorage`) scopes the flag to
 * the tab and clears itself when the tab closes; every access is guarded because it throws in
 * private-mode and partitioned contexts.
 */
export const RELOAD_GUARD_KEY = "shepherd:error-reloaded";

export function shouldAutoReload(
  kind: ClientErrorKind,
  storage: Pick<Storage, "getItem" | "setItem"> | null | undefined,
): boolean {
  if (kind !== "chunk" || !storage) return false;
  try {
    if (storage.getItem(RELOAD_GUARD_KEY)) return false;
    storage.setItem(RELOAD_GUARD_KEY, "1");
    return true;
  } catch {
    // Storage unavailable (private mode, blocked cookies): prefer the error page over a
    // reload we cannot bound — an unguarded reload on a dead link is an infinite loop.
    return false;
  }
}
