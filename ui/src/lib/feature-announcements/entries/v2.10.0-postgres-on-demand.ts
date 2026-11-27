import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // Covers the repo picker in Settings › Resources › Postgres and the card menu's "Make database
  // the repo template" (#4240) too (same unreleased 2.10.0).
  // No targetId: the only <Coachmark> host (ViewportTabBar) arms just the critic/auto-address
  // tab features, so an anchor in Settings would be dead. Surfaces via the What's-New drawer.
  id: "postgres-on-demand",
  sinceVersion: "2.10.0",
  titleKey: "feat_postgres_title",
  bodyKey: "feat_postgres_body",
} satisfies FeatureAnnouncement;
