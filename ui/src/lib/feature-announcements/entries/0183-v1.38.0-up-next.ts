import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Up Next (#1169): a top-level lens ranking un-started GitHub issues across all repos into
  // one cross-repo queue, with one-click (single + batch) Start. Anchored to the lens button
  // via use:coachTarget={"up-next-lens"} in HerdLensStrip/HerdSegRow. 1.37.0 is the latest
  // released tag, so this ships in 1.38.0.
  id: "up-next",
  sinceVersion: "1.38.0",
  titleKey: "feat_upnext_title",
  bodyKey: "feat_upnext_body",
  targetId: "up-next-lens",
} satisfies FeatureAnnouncement;

export default entry;
