// Build/repo facts injected at build time (see vite.config.ts `define`), shared
// by the desktop ActionBar footer and the mobile Settings → Device "About" block.
export const REPO = "erwins-enkel/shepherd";
export const REPO_URL = `https://github.com/${REPO}`;
// Hosted documentation site — distinct from REPO_URL (the GitHub source/README).
export const DOCS_URL = "https://docs.shepherd.run/";
export const sha = __GIT_SHA__;
export const version = __APP_VERSION__;
// Release tag → date (`{ "1.20.0": "2026-06-09", … }`), keyed without leading `v`.
// Used by the What's-New drawer to date each entry's `sinceVersion`.
export const releaseDates = __RELEASE_DATES__;
// `__GIT_SHA__` defaults to "unknown" when git is unavailable; fall back to the repo.
export const commitUrl = sha === "unknown" ? REPO_URL : `https://github.com/${REPO}/commit/${sha}`;
