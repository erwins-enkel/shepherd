import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // The usage panel's weekly-limit switch names the repos set to the exhausted CLI (#3448).
  id: "failover-staying-repos",
  sinceVersion: "2.8.0",
  titleKey: "feat_failover_staying_repos_title",
  bodyKey: "feat_failover_staying_repos_body",
} satisfies FeatureAnnouncement;
