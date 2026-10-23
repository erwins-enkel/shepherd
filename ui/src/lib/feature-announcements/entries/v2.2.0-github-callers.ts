import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the GitHub tab lives inside the Usage modal, which isn't mounted
  // until opened — no stable always-present anchor. What's-New drawer only.
  id: "github-callers",
  sinceVersion: "2.2.0",
  titleKey: "feat_github_callers_title",
  bodyKey: "feat_github_callers_body",
} satisfies FeatureAnnouncement;

export default entry;
