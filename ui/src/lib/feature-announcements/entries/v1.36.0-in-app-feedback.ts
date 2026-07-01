import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // In-app feedback (#971): gear menu, mobile sheet, and Settings → Device each expose
  // Report a bug / Request a feature / Send feedback, opening a prefilled GitHub issue form.
  // No targetId — the menu/sheet anchors aren't persistently mounted, so it's drawer-only.
  // v1.35.0 is the latest released tag → ships in 1.36.0.
  id: "in-app-feedback",
  sinceVersion: "1.36.0",
  titleKey: "feat_feedback_title",
  bodyKey: "feat_feedback_body",
} satisfies FeatureAnnouncement;

export default entry;
