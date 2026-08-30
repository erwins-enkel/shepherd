// Version segment for the generated icon directory (static/icons/<version>/).
//
// Lives in its own module so importing it has no side effects: gen-icons.mjs writes files at import
// time, so a test that pulled the constant from there would regenerate the committed assets just by
// importing it.
//
// Bumping this is the cache-bust lever — desktop Chrome since 144 only re-reads a manifest icon when
// its URL changes. Bump it here AND in the paths inside manifest.webmanifest, static/sw.js and
// src/app.html; gen-icons.test.ts fails a half-done bump.
export const ICONS_VERSION = "v2";
