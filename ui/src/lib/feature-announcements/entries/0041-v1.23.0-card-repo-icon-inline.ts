import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the inline emoji only mounts on cards whose repo has a
  // configured icon, so an anchor isn't guaranteed to exist — surface via the
  // What's-New drawer only. v1.22.0 is already tagged → ships in 1.23.0.
  id: "card-repo-icon-inline",
  sinceVersion: "1.23.0",
  titleKey: "feat_card_repo_icon_title",
  bodyKey: "feat_card_repo_icon_body",
} satisfies FeatureAnnouncement;

export default entry;
