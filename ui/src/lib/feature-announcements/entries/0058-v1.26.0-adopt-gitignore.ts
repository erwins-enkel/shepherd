import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // targetId "adopt-gitignore" matches the use:coachTarget id on the adopt button
  // in ReadinessPanel.svelte (mounts on the Backlog Readiness tab). 1.25.0 is
  // already released, so this ships in 1.26.0: computeNewEntries only surfaces
  // entries with sinceVersion > lastSeen.
  id: "adopt-gitignore",
  sinceVersion: "1.26.0",
  titleKey: "feat_adopt_gitignore_title",
  bodyKey: "feat_adopt_gitignore_body",
  targetId: "adopt-gitignore",
} satisfies FeatureAnnouncement;

export default entry;
