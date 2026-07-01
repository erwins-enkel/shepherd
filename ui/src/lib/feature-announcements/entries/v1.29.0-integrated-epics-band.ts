import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the band only mounts when there are completed epics, so a
  // coachmark anchor would usually be absent — surface via the What's-New drawer
  // only. 1.28.0 is the latest released tag, so this ships in 1.29.0.
  id: "integrated-epics-band",
  sinceVersion: "1.29.0",
  titleKey: "feat_integrated_epics_title",
  bodyKey: "feat_integrated_epics_body",
} satisfies FeatureAnnouncement;

export default entry;
