import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: only the automation-pill coachmarks are armed (PILL_FEATURE_IDS
  // in GitRail.svelte), so an anchor on the header title would never fire —
  // surface via the What's-New drawer only. v1.26.0 is already released, so this
  // ships in the next release (1.27.0): computeNewEntries only surfaces entries
  // with sinceVersion > lastSeen.
  id: "title-rename-shortcut",
  sinceVersion: "1.27.0",
  titleKey: "feat_title_rename_title",
  bodyKey: "feat_title_rename_body",
} satisfies FeatureAnnouncement;

export default entry;
