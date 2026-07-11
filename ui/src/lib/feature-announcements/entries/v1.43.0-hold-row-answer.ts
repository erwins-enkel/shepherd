import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Sessions paused on a question (autopilot paused, or waiting on a yes/no) now show an
  // Answer button on their row — click it to open the session and reply.
  id: "hold-row-answer",
  sinceVersion: "1.43.0",
  titleKey: "feat_hold_row_answer_title",
  bodyKey: "feat_hold_row_answer_body",
} satisfies FeatureAnnouncement;

export default entry;
