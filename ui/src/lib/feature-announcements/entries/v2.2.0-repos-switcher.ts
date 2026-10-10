import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The repo name in the Repos dialog's header (or R) opens the switcher popover; the
  // sidebar is gone. No targetId: like slot-stepper, it only mounts inside the Repos
  // dialog, which no <Coachmark> host is mounted in.
  id: "repos-switcher",
  sinceVersion: "2.2.0",
  titleKey: "feat_repos_switcher_title",
  bodyKey: "feat_repos_switcher_body",
} satisfies FeatureAnnouncement;

export default entry;
