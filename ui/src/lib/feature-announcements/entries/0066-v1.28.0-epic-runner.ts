import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the Epic panel only mounts when a session is actively running an
  // epic (a tracking-issue link is set), so a coachmark anchor would rarely exist —
  // surface via the What's-New drawer only. 1.27.0 is already released, so this
  // ships in 1.28.0: computeNewEntries only surfaces entries with sinceVersion > lastSeen.
  id: "epic-runner",
  sinceVersion: "1.28.0",
  titleKey: "feat_epic_runner_title",
  bodyKey: "feat_epic_runner_body",
} satisfies FeatureAnnouncement;

export default entry;
