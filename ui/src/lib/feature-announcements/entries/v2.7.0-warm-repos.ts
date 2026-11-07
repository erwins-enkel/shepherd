import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // #2837: background GitHub reads only for warm repos; cold ones show last-known values + age.
  id: "warm-repos",
  sinceVersion: "2.7.0",
  titleKey: "feat_warm_repos_title",
  bodyKey: "feat_warm_repos_body",
} satisfies FeatureAnnouncement;
