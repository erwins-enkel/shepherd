import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // targetId "herd-rundown" anchors the coachmark on the left-list RUNDOWN filter
  // tab (Herd.svelte desktop fbtn). The tab is unmounted when the sidebar is
  // collapsed, so the coachmark degrades to drawer-only in that case. 1.31.0 is
  // the latest released tag, so this ships in 1.32.0.
  id: "herd-rundown",
  sinceVersion: "1.32.0",
  titleKey: "feat_herd_rundown_title",
  bodyKey: "feat_herd_rundown_body",
  targetId: "herd-rundown",
} satisfies FeatureAnnouncement;

export default entry;
