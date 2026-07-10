import type { FeatureAnnouncement } from "../../feature-announcements";

// No targetId/coachmark: the plan-review control only mounts while a session is in the planning
// phase (a transient state), so an anchored coachmark could not reliably fire. Surfaced through
// the What's-New drawer only.
const entry = {
  id: "manual-plan-rereview",
  sinceVersion: "1.43.0",
  titleKey: "feat_manual_plan_rereview_title",
  bodyKey: "feat_manual_plan_rereview_body",
} satisfies FeatureAnnouncement;

export default entry;
