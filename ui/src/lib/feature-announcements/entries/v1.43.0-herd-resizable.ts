import type { FeatureAnnouncement } from "../../feature-announcements";

// No targetId/coachmark: GitRail's only <Coachmark> host arms exclusively from
// PILL_FEATURE_IDS (critic, auto-address, learnings), so a splitter target could
// never fire. This feature is surfaced through the What's-New drawer only.
const entry = {
  id: "herd-resizable",
  sinceVersion: "1.43.0",
  titleKey: "feat_herd_resizable_title",
  bodyKey: "feat_herd_resizable_body",
} satisfies FeatureAnnouncement;

export default entry;
