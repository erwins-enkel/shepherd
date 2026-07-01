import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the badge is per-row/dynamic — there's no single stable anchor
  // for a coachmark. Surface via the What's-New drawer only.
  id: "native-sub-issues",
  sinceVersion: "1.28.0",
  titleKey: "feat_native_sub_issues_title",
  bodyKey: "feat_native_sub_issues_body",
} satisfies FeatureAnnouncement;

export default entry;
