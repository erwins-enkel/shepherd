// Catalog driving the What's-New drawer + first-view coachmarks.
//
// CONTRACT: every shipped user-facing feature adds ONE entry fragment under
// ./feature-announcements/entries/ in the SAME PR as the feature — id,
// sinceVersion (the release it ships in), titleKey/bodyKey (added to BOTH
// ui/messages/en.json and de.json), and an optional targetId paired with
// `use:coachTarget` on the anchor element. Enforced by the
// `scripts/check-feature-catalog.sh` gate (PR-hygiene CI + pre-push).
// See CLAUDE.md → "Feature discovery (REQUIRED for user-facing features)".
//
// FILENAME: `v<sinceVersion>-<id>.ts` — NO sequence number. Uniqueness comes
// from the id (globally unique, enforced by the dup-id guard in
// feature-gate.test.ts), so two concurrent PRs can never collide on a filename
// or need to coordinate a counter. That collision-free property is the whole
// point of one-file-per-entry; a shared monotonic prefix would reintroduce the
// exact merge-conflict hotspot the split removed.

export type FeatureAnnouncement = {
  id: string;
  sinceVersion: string;
  titleKey: string;
  bodyKey: string;
  targetId?: string;
};

type FeatureAnnouncementModule = {
  default: FeatureAnnouncement;
};

/** The catalog id for the Fable 5 launch. When this entry is "new" for an
 *  upgrading user, +page.svelte fires the one-time FableArrival celebration
 *  in addition to listing it in the What's-New drawer. */
export const FABLE_FEATURE_ID = "fable-5";

const modules = import.meta.glob<FeatureAnnouncementModule>(
  "./feature-announcements/entries/*.ts",
  { eager: true },
);

function parseSemver(v: string): [number, number, number] {
  const [major, minor, patch] = v.split(".").map((part) => Number.parseInt(part, 10));
  return [major || 0, minor || 0, patch || 0];
}

function compareSemver(a: string, b: string): number {
  const av = parseSemver(a);
  const bv = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    if (av[i] !== bv[i]) return av[i] - bv[i];
  }
  return 0;
}

// Order: sinceVersion ascending (release grouping), then filename as a stable,
// deterministic tiebreak (alphabetical by id within a release — cosmetic, since
// computeNewEntries surfaces newest release first and only within-release order
// is affected). No curated cross-release order to maintain.
export const featureAnnouncements: readonly FeatureAnnouncement[] = Object.entries(modules)
  .sort(([aPath, aModule], [bPath, bModule]) => {
    const byVersion = compareSemver(aModule.default.sinceVersion, bModule.default.sinceVersion);
    if (byVersion !== 0) return byVersion;
    return aPath.localeCompare(bPath);
  })
  .map(([, module]) => module.default);
