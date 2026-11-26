import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // Repo settings → Agent → Postgres on request → "Database at every spawn" (#4238). No targetId,
  // like postgres-on-demand: no Coachmark host arms an anchor in Repo settings.
  id: "postgres-auto",
  sinceVersion: "2.10.0",
  titleKey: "feat_postgres_auto_title",
  bodyKey: "feat_postgres_auto_body",
} satisfies FeatureAnnouncement;
