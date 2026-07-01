import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the pencil only mounts on the steer bar (focused-session view) and
  // only when the bar isn't crowded — on mobile/overflow the ABC toggle takes the
  // slot — so a coachmark anchor would often be absent. Surface via the What's-New
  // drawer only. 1.26.0 is already released, so this ships in 1.27.0.
  id: "steerbar-edit",
  sinceVersion: "1.27.0",
  titleKey: "feat_steerbar_edit_title",
  bodyKey: "feat_steerbar_edit_body",
} satisfies FeatureAnnouncement;

export default entry;
