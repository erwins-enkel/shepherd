import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the band only mounts when there are completed epics, and the
  // landing-PR link only appears once the aggregate PR is open, so a coachmark
  // anchor would usually be absent — surface via the What's-New drawer only.
  // 1.29.0 is the latest released tag, so this ships in 1.30.0: computeNewEntries
  // only surfaces entries with sinceVersion > lastSeen.
  id: "epic-landing-pr",
  sinceVersion: "1.30.0",
  titleKey: "feat_epic_landing_pr_title",
  bodyKey: "feat_epic_landing_pr_body",
} satisfies FeatureAnnouncement;

export default entry;
