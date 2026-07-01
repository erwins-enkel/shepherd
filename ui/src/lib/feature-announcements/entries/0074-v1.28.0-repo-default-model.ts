import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the picker lives inside the AutomationPanel popover (closed by
  // default), so a coachmark anchor would rarely be mounted — surface via the
  // What's-New drawer only. 1.27.0 is already released, so this ships in 1.28.0.
  id: "repo-default-model",
  sinceVersion: "1.28.0",
  titleKey: "feat_repo_default_model_title",
  bodyKey: "feat_repo_default_model_body",
} satisfies FeatureAnnouncement;

export default entry;
