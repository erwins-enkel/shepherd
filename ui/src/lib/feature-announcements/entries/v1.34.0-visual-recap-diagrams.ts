import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Extends visual recaps (Phase 3) with rendered Mermaid architecture/flow diagrams.
  // 1.33.0 is the latest released tag, so this ships in 1.34.0.
  id: "visual-recap-diagrams",
  sinceVersion: "1.34.0",
  titleKey: "feat_visual_recap_diagrams_title",
  bodyKey: "feat_visual_recap_diagrams_body",
  targetId: "session-recap",
} satisfies FeatureAnnouncement;

export default entry;
