import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the version/date stamps live inside this very drawer, which is
  // not a persistent chrome anchor — surface via the What's-New drawer only.
  // 1.21.0 is already tagged, so this ships in the next release (1.22.0):
  // computeNewEntries only surfaces entries with sinceVersion > lastSeen.
  id: "whatsnew-version-date",
  sinceVersion: "1.22.0",
  titleKey: "feat_whatsnew_versiondate_title",
  bodyKey: "feat_whatsnew_versiondate_body",
} satisfies FeatureAnnouncement;

export default entry;
