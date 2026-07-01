import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the stepper appears once per session card in a dense list — there
  // can be many steppers in the DOM simultaneously, and coachTargets keys one node
  // per id, so a duplicated targetId anchor would be wrong. Surface via the
  // What's-New drawer only.
  id: "stepper-stage-legend",
  sinceVersion: "1.23.0",
  titleKey: "feat_stepper_legend_title",
  bodyKey: "feat_stepper_legend_body",
} satisfies FeatureAnnouncement;

export default entry;
