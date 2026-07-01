import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the feature is a server-sent push notification (fires when the app
  // is closed/inactive), so there is no anchor element — What's-New drawer only.
  // Bumped from 1.22.0 → 1.23.0 on merge-train rebase: 1.22.0 is already tagged, so
  // computeNewEntries (sinceVersion > lastSeen) would never surface a 1.22.0 entry.
  id: "usage-limit-push",
  sinceVersion: "1.23.0",
  titleKey: "feat_usage_limit_push_title",
  bodyKey: "feat_usage_limit_push_body",
} satisfies FeatureAnnouncement;

export default entry;
