// Build/repo facts injected at build time (see vite.config.ts `define`), shared
// by the desktop ActionBar footer and the mobile Settings → Device "About" block.
export const REPO = "erwins-enkel/shepherd";
export const REPO_URL = `https://github.com/${REPO}`;
export const sha = __GIT_SHA__;
export const version = __APP_VERSION__;
// `__GIT_SHA__` defaults to "unknown" when git is unavailable; fall back to the repo.
export const commitUrl = sha === "unknown" ? REPO_URL : `https://github.com/${REPO}/commit/${sha}`;
