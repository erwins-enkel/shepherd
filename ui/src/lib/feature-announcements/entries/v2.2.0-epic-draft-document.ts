import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The epic draft review renders its Markdown and opens as a wide document on desktop: a table
  // of contents, waves and blocker jump links per child, and the approve outcome up front.
  id: "epic-draft-document",
  sinceVersion: "2.2.0",
  titleKey: "feat_epic_draft_document_title",
  bodyKey: "feat_epic_draft_document_body",
} satisfies FeatureAnnouncement;

export default entry;
