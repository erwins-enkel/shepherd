import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the doc-links live in the Settings → Diagnostics tab (modal closed
  // by default), so surface via the What's-New drawer only, like the prior
  // "diagnose-one-click-fix" entry. 1.31.0 is the latest released tag → ships in 1.32.0.
  id: "diagnose-doc-links",
  sinceVersion: "1.32.0",
  titleKey: "feat_diagnose_doc_links_title",
  bodyKey: "feat_diagnose_doc_links_body",
} satisfies FeatureAnnouncement;

export default entry;
