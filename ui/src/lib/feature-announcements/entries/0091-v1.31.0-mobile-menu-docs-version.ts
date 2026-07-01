import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the link lives inside the gear menu (closed by default) and is
  // mobile-only, so a desktop coachmark anchor would mislead — surface via the
  // What's-New drawer only. 1.30.0 is the latest released tag, so this ships in 1.31.0.
  id: "mobile-menu-docs-version",
  sinceVersion: "1.31.0",
  titleKey: "feat_mobile_menu_docs_title",
  bodyKey: "feat_mobile_menu_docs_body",
} satisfies FeatureAnnouncement;

export default entry;
