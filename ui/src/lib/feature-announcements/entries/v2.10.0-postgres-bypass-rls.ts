import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // Repo settings → Agent → Postgres on request → "Row-level security bypass". No targetId, like
  // postgres-auto: no Coachmark host arms an anchor in Repo settings.
  id: "postgres-bypass-rls",
  sinceVersion: "2.10.0",
  titleKey: "feat_postgres_bypass_rls_title",
  bodyKey: "feat_postgres_bypass_rls_body",
} satisfies FeatureAnnouncement;
