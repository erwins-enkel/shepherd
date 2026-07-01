import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the research toggle lives on the New Task sheet (a modal closed by
  // default), so a coachmark anchor would rarely be mounted — surface via What's-New only.
  // 1.28.0 is the latest released tag, so this ships in 1.29.0.
  id: "research-task",
  sinceVersion: "1.29.0",
  titleKey: "feat_research_title",
  bodyKey: "feat_research_body",
} satisfies FeatureAnnouncement;

export default entry;
