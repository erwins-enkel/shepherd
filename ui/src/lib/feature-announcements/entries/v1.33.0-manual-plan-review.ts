import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the only <Coachmark> host (GitRail) arms exclusively over
  // PILL_FEATURE_IDS, and WhatsNew surfaces entries by text. An anchored coachmark
  // would never fire (and the Review-plan button is anyway unmounted on desktop
  // until the git disclosure expands, and only exists while planPhase==="planning").
  // Discovery is via the What's-New drawer.
  id: "manual-plan-review",
  sinceVersion: "1.33.0",
  titleKey: "feat_manual_plan_review_title",
  bodyKey: "feat_manual_plan_review_body",
} satisfies FeatureAnnouncement;

export default entry;
