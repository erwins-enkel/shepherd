import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the toggle lives in the Settings modal DEVICE tab (closed by
  // default), so a coachmark anchor would rarely be mounted — surface via the
  // What's-New drawer only. v1.28.0 is already released, so this ships in 1.29.0:
  // computeNewEntries surfaces entries where lastSeen < sinceVersion <= current app version.
  id: "colorblind-status-markers",
  sinceVersion: "1.29.0",
  titleKey: "feat_colorblind_markers_title",
  bodyKey: "feat_colorblind_markers_body",
} satisfies FeatureAnnouncement;

export default entry;
