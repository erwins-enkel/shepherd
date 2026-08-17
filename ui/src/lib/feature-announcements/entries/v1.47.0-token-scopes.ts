import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Per-token scopes (#2083). Ships in the same unreleased version as the tokens themselves
  // (#2082, v1.47.0-access-tokens.ts), and entries sort by sinceVersion then FILENAME — so
  // "access-tokens" precedes "token-scopes" and the two cards read in the order that makes sense
  // ("you can mint tokens" → "and they carry a scope"). Don't rename either file past the other.
  id: "token-scopes",
  sinceVersion: "1.47.0",
  titleKey: "feat_token_scopes_title",
  bodyKey: "feat_token_scopes_body",
} satisfies FeatureAnnouncement;

export default entry;
