import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Starting an epic while another leads the repo asks first (#2623): the leader's state and
  // what superseding it leaves behind. No targetId: the dialog only opens on Start.
  id: "epic-supersede-confirm",
  sinceVersion: "2.1.0",
  titleKey: "feat_epic_supersede_confirm_title",
  bodyKey: "feat_epic_supersede_confirm_body",
} satisfies FeatureAnnouncement;

export default entry;
