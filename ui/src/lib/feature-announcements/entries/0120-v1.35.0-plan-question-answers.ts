import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The plan question-form is now answerable in-UI: pick options / type freeform and the
  // answers steer back into the planning agent. No targetId — PlanPanel is an on-demand
  // modal with no stable always-visible anchor. v1.34.0 is the latest tag → ships in 1.35.0.
  id: "plan-question-answers",
  sinceVersion: "1.35.0",
  titleKey: "feat_plan_question_answers_title",
  bodyKey: "feat_plan_question_answers_body",
} satisfies FeatureAnnouncement;

export default entry;
