import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the prescription lives in the Backlog → Readiness panel's
  // generated-snippet block (Copy / Send-to-task), several clicks deep — surface
  // via the What's-New drawer only. 1.29.0 is the latest released tag, so this
  // ships in 1.30.0.
  id: "readiness-install-commands",
  sinceVersion: "1.30.0",
  titleKey: "feat_readiness_install_commands_title",
  bodyKey: "feat_readiness_install_commands_body",
} satisfies FeatureAnnouncement;

export default entry;
