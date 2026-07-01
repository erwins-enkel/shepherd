import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: glossary terms are list-repeated inline across What's-New and coachmark
  // body text — there is no single stable anchor element to point a coachmark at (same
  // rationale as session-epic-badge and backlog-repo-filter). Surface via the What's-New
  // drawer only. 1.29.0 is the latest released tag, so this ships in 1.30.0.
  id: "glossary-tooltips",
  sinceVersion: "1.30.0",
  titleKey: "feat_glossary_title",
  bodyKey: "feat_glossary_body",
} satisfies FeatureAnnouncement;

export default entry;
