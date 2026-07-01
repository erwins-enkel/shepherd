import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // #809: a signed-off plan is now reachable during execution via a read-only PLAN chip on the
  // session row/tile/viewport. No targetId — the chip only appears in the executing phase and the
  // plan opens in an on-demand modal (PlanPanel), with no stable always-visible anchor (mirrors
  // the plan-question-answers entry). v1.34.0 is the latest tag → ships in 1.35.0.
  id: "plan-reopen-execution",
  sinceVersion: "1.35.0",
  titleKey: "feat_plan_reopen_title",
  bodyKey: "feat_plan_reopen_body",
} satisfies FeatureAnnouncement;

export default entry;
