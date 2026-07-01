import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the fold chevron only mounts on the compact/mobile layout, so a
  // coachmark anchor would rarely be present on first view — surface via the
  // What's-New drawer only.
  id: "header-fold",
  sinceVersion: "1.20.0",
  titleKey: "feat_header_fold_title",
  bodyKey: "feat_header_fold_body",
} satisfies FeatureAnnouncement;

export default entry;
