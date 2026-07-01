import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the ⟲ Sync button only renders on fork rows inside the repo
  // picker (RepoSelect), which is closed by default — a coachmark anchor would
  // usually be unmounted, so surface via the What's-New drawer only. 1.31.0 is the
  // latest released tag (the fork-repo feature above), so this ships in 1.32.0.
  id: "fork-sync",
  sinceVersion: "1.32.0",
  titleKey: "feat_fork_sync_title",
  bodyKey: "feat_fork_sync_body",
} satisfies FeatureAnnouncement;

export default entry;
