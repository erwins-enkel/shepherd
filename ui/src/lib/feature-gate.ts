import type { FeatureAnnouncement } from "./feature-announcements";

/** Parse a semver string into [major, minor, patch] or null if unparseable. */
function parse(v: string): [number, number, number] | null {
  const parts = v.split(".");
  if (parts.length < 3) return null;
  const nums = parts.slice(0, 3).map((p) => parseInt(p, 10));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return [nums[0], nums[1], nums[2]];
}

/** Compare two parsed semver tuples. Returns -1 | 0 | 1. */
function cmp(a: [number, number, number], b: [number, number, number]): -1 | 0 | 1 {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

/**
 * Return catalog entries that are new since `lastSeenVersion`.
 *
 * - currentVersion unparseable (e.g. "dev") → []  (never throws)
 * - lastSeenVersion === null (fresh install) → []  (caller seeds baseline)
 * - lastSeenVersion unparseable → []
 * - current <= lastSeen → []
 * - otherwise: entries where sinceVersion > lastSeen (unparseable sinceVersion excluded)
 */
export function computeNewEntries(
  lastSeenVersion: string | null,
  currentVersion: string,
  catalog: readonly FeatureAnnouncement[],
): FeatureAnnouncement[] {
  const current = parse(currentVersion);
  if (!current) return [];

  if (lastSeenVersion === null) return [];

  const lastSeen = parse(lastSeenVersion);
  if (!lastSeen) return [];

  if (cmp(current, lastSeen) <= 0) return [];

  return catalog.filter((entry) => {
    const since = parse(entry.sinceVersion);
    if (!since) return false;
    return cmp(since, lastSeen) > 0 && cmp(since, current) <= 0;
  });
}
