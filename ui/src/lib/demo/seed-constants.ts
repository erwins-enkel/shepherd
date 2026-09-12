// The handful of values every seed module must agree on. Extracted from `seed.ts` when
// the per-repo lens and usage fixtures moved into their own modules (#2295): two seeds
// that disagree about a repo path, a PR's URL or the clock anchor make the demo
// contradict itself, which is a worse bug than the empty panel it replaced.
//
// Pure data + one pure helper — no imports, so nothing can cycle through here.

export const STOREFRONT = "/demo/acme/storefront";
export const API = "/demo/acme/api";
export const EPIC_PARENT = 100;

// A fixed clock anchor so the seed is deterministic (the director advances live
// timestamps at runtime). Every seeded offset is relative to this — never `Date.now()`.
export const NOW = Date.UTC(2026, 5, 30, 12, 0, 0);
export const SEC = 1_000;
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** The demo operator's own forge login — `listIssues`' `viewer`, which drives the
 *  "mine & unassigned" issue filter and the "assigned to someone else" notice.
 *  Also the author of every seeded PR the operator's own sessions opened. */
export const DEMO_VIEWER = "acme-dev";

/** Seeded repoPath → its forge web URL. The seeded repoPaths are `/demo/<slug>`, so the
 *  slug in every issue/PR/run URL is derived from the SAME string the repo index carries. */
export const gh = (repo: string): string => repo.replace("/demo/", "https://github.com/");
