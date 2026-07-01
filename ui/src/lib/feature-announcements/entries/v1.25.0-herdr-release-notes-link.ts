import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the herdr update modal is only mounted while open (and only when an
  // update is available), so a coachmark anchor would rarely exist — surface via the
  // What's-New drawer only. v1.24.0 is already tagged, so this ships in 1.25.0.
  id: "herdr-release-notes-link",
  sinceVersion: "1.25.0",
  titleKey: "feat_herdr_release_notes_link_title",
  bodyKey: "feat_herdr_release_notes_link_body",
} satisfies FeatureAnnouncement;

export default entry;
