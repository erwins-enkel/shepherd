/**
 * Version-probe helpers shared by the herdr and codex updaters. Both parse an
 * installed CLI's version from a `versionRunner()` callback via a semver regex,
 * and both need a never-throws "best effort" variant for failure branches — the
 * two implementations were otherwise byte-identical. Leaf module (no imports),
 * mirrors semver.ts's role for compareSemver.
 */

/** Extract the first semver token (`re`) from `versionRunner()`'s output; null if
 *  unreadable. Propagates a throw from `versionRunner` itself (e.g. the binary is
 *  missing) — see {@link readActualVersion} for the never-throws variant. */
export function readInstalledVersion(versionRunner: () => string, re: RegExp): string | null {
  const m = re.exec(versionRunner());
  return m ? m[1]! : null;
}

/** Best-effort installed version for the "what are we ACTUALLY on?" report. Never
 *  throws — a missing/exploding version probe falls back to `fallback` (the
 *  last-known-good). Used by every failure branch so a caller never claims the
 *  operator reached a target version they did not. */
export function readActualVersion(
  versionRunner: () => string,
  re: RegExp,
  fallback: string | null,
): string | null {
  try {
    return readInstalledVersion(versionRunner, re) ?? fallback;
  } catch {
    return fallback;
  }
}
