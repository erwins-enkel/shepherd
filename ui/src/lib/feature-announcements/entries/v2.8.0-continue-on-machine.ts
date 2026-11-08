import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // "Continue with…" names a machine: the session moves there with its work (same branch and PR).
  id: "continue-on-machine",
  sinceVersion: "2.8.0",
  titleKey: "feat_continue_on_machine_title",
  bodyKey: "feat_continue_on_machine_body",
} satisfies FeatureAnnouncement;
