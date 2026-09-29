// Types for the node-run version helper (scripts/next-version.mjs). The helper
// stays plain .mjs so `node scripts/next-version.mjs` works as a CLI in any
// context; this declaration only exists so TypeScript importers (the unit test
// and scripts/check-announcement-versions.mjs) get real types instead of `any`.

/** Parse "x.y.z" into [major, minor, patch]; throws on a non-semver string. */
export function parseSemver(v: string): [number, number, number];

/** Compare two semver strings. Returns <0, 0, or >0 (a<b, a==b, a>b). */
export function compareSemver(a: string, b: string): number;

/** The last released version, from the release-please manifest's root package. */
export function readReleasedVersion(): string;

/** The next unreleased version — a minor bump off the last release. */
export function nextVersion(released?: string): string;

/** Every released version, from release-please's `## [x.y.z]` CHANGELOG headings. */
export function readChangelogVersions(text?: string): Set<string>;

/** True when `since` was never released and is no longer upcoming (<= `released`). */
export function strandedVersion(since: string, releasedSet: Set<string>, released: string): boolean;
