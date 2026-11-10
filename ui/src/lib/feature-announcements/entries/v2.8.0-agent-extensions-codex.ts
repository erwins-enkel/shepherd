import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // The per-repo plugin / skill allowlists (#3780) now cover Codex too, with All/None per group.
  id: "agent-extensions-codex",
  sinceVersion: "2.8.0",
  titleKey: "feat_agent_extensions_codex_title",
  bodyKey: "feat_agent_extensions_codex_body",
} satisfies FeatureAnnouncement;
