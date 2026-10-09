import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Repos opens on a repo grid unless exactly one repo is filtered on the dashboard. No
  // targetId: like repos-switcher, it only mounts inside the Repos dialog, which no
  // <Coachmark> host is mounted in.
  id: "repos-grid",
  sinceVersion: "2.2.0",
  titleKey: "feat_repos_grid_title",
  bodyKey: "feat_repos_grid_body",
} satisfies FeatureAnnouncement;

export default entry;
