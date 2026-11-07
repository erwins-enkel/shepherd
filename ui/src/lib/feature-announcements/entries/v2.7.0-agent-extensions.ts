import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // Per-repo plugin / personal-skill allowlists in the automation settings (#3780).
  id: "agent-extensions",
  sinceVersion: "2.7.0",
  titleKey: "feat_agent_extensions_title",
  bodyKey: "feat_agent_extensions_body",
} satisfies FeatureAnnouncement;
