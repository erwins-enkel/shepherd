import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The usage popover / mobile sheet now labels its provider sections ("Claude Code usage" vs
  // "Codex usage") so it's clear which rows belong to which coding CLI.
  id: "usage-provider-sections",
  sinceVersion: "1.42.0",
  titleKey: "feat_usage_provider_sections_title",
  bodyKey: "feat_usage_provider_sections_body",
} satisfies FeatureAnnouncement;

export default entry;
