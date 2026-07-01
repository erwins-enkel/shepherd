import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The daily Herd Rundown now injects landing-ready integrated epics as a Tier-1 "land these
  // epics" section — surfacing a forgotten last-mile landing even when no session is live. No
  // targetId — the section mounts only when a landing-ready epic exists; surface via the What's-New
  // drawer only. v1.36.0 → ships in 1.37.0.
  id: "rundown-epics-to-land",
  sinceVersion: "1.37.0",
  titleKey: "feat_rundown_epics_to_land_title",
  bodyKey: "feat_rundown_epics_to_land_body",
} satisfies FeatureAnnouncement;

export default entry;
