import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the About section lives inside the Settings modal, closed by
  // default, so a coachmark anchor would rarely be mounted — surface via the
  // What's-New drawer only. Ships in the next release (1.22.0); 1.21.0 is already
  // tagged so a 1.21.0 entry would never surface (computeNewEntries only shows
  // sinceVersion > lastSeen).
  id: "product-framing-refresh",
  sinceVersion: "1.22.0",
  titleKey: "feat_product_story_title",
  bodyKey: "feat_product_story_body",
} satisfies FeatureAnnouncement;

export default entry;
