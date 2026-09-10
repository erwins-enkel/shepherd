/**
 * Cache for a forge's "who am I" lookup — the operator's own login, which drives the
 * "mine & unassigned" issue filter (#824).
 *
 * Caching is **asymmetric**, mirroring `makeForgeMemo` in ./resolve.ts:
 *  - **Positive** (a login) is cached for the process lifetime. The authenticated
 *    identity never changes mid-session, so one lookup serves every caller.
 *  - **Negative** (the probe threw, or answered without a login) is cached only for
 *    `negativeTtlMs`, then re-probed. This is the #2140 fix: remembering a FAILURE for
 *    the forge's lifetime — and forge instances are memoised per process — let a single
 *    ill-timed 403 pin the viewer to `null` until a restart, silently turning the filter
 *    into "show everything" with no chip and no explanation.
 *
 * The TTL is what makes the retry affordable: `pr-poller`'s `refresh()` resolves the
 * viewer for every session on every sweep, so an unbounded retry would mean a fresh
 * probe per session per tick while the forge is unreachable.
 *
 * `now` is injectable purely so tests can drive the TTL deterministically.
 */

/** Default window before a failed resolution is re-probed. Matches `makeForgeMemo`'s. */
const DEFAULT_NEGATIVE_TTL_MS = 30_000;

export function makeUserCache(
  probe: () => Promise<string | null>,
  opts: { negativeTtlMs?: number; now?: () => number } = {},
): () => Promise<string | null> {
  const ttl = opts.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
  const now = opts.now ?? Date.now;
  let login: string | null = null;
  let failedAt: number | null = null;

  return async (): Promise<string | null> => {
    if (login !== null) return login;
    if (failedAt !== null && now() - failedAt < ttl) return null;

    // A throwing probe is a failure like any other — callers want "unknown me", never
    // an exception, since every consumer of the viewer fails open on null.
    const resolved = await probe().catch(() => null);
    if (resolved) {
      login = resolved;
      failedAt = null;
      return login;
    }
    failedAt = now();
    return null;
  };
}
