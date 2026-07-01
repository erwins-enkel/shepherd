import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the Resume button + card menu only appear on a parked (idle/done)
  // session, so a coachmark anchor would rarely be mounted — surface via the
  // What's-New drawer only.
  id: "resume-parked-session",
  sinceVersion: "1.20.0",
  titleKey: "feat_resume_session_title",
  bodyKey: "feat_resume_session_body",
} satisfies FeatureAnnouncement;

export default entry;
