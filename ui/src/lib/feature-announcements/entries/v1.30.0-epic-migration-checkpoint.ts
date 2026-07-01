import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the migration chip only appears on a completed-epic row whose landing PR
  // carries migration files, so a coachmark anchor would usually be absent — surface via the
  // What's-New drawer only. 1.29.0 is the latest released tag, so this ships in 1.30.0.
  id: "epic-migration-checkpoint",
  sinceVersion: "1.30.0",
  titleKey: "feat_epic_migrations_title",
  bodyKey: "feat_epic_migrations_body",
} satisfies FeatureAnnouncement;

export default entry;
