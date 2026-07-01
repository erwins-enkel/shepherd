import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // targetId "session-recap" matches use:coachTarget on the recap card root in
  // SessionRecap.svelte, so the coachmark can point at it.
  id: "session-recap",
  sinceVersion: "1.29.0",
  titleKey: "feat_session_recap_title",
  bodyKey: "feat_session_recap_body",
  targetId: "session-recap",
} satisfies FeatureAnnouncement;

export default entry;
