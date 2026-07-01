import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the toggle lives inside the AutomationPanel popover (closed by
  // default), so a coachmark anchor would rarely be mounted — surface via the
  // What's-New drawer only. 1.27.0 is already released, so this ships in 1.28.0:
  // computeNewEntries only surfaces entries with sinceVersion > lastSeen.
  id: "standalone-pr-critic",
  sinceVersion: "1.28.0",
  titleKey: "feat_critic_all_prs_title",
  bodyKey: "feat_critic_all_prs_body",
} satisfies FeatureAnnouncement;

export default entry;
