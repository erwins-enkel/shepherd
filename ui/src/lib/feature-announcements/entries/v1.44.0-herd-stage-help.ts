import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the only <Coachmark> host (GitRail) arms exclusively from PILL_FEATURE_IDS,
  // so an anchored coachmark on a Herd board header would never fire. The feature is
  // discoverable via the always-visible per-header "i" (a discovery-forward resting state)
  // plus the empty-board "How work flows" overview. 1.43.0 is the latest released tag, so
  // this ships in 1.44.0.
  id: "herd-stage-help",
  sinceVersion: "1.44.0",
  titleKey: "feat_herd_stage_help_title",
  bodyKey: "feat_herd_stage_help_body",
} satisfies FeatureAnnouncement;

export default entry;
