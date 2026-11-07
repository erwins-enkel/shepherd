import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the GitHub tab lives inside the Usage modal, which isn't mounted
  // until opened — no stable always-present anchor. What's-New drawer only.
  id: "github-write-split",
  sinceVersion: "2.7.0",
  titleKey: "feat_github_write_split_title",
  bodyKey: "feat_github_write_split_body",
} satisfies FeatureAnnouncement;

export default entry;
