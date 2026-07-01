import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the badges live on backlog repo-list rows (only mounted on the
  // Backlog view) and the list scrolls, so a coachmark anchor would often be
  // unmounted — surface via the What's-New drawer only. 1.25.0 is already
  // released, so this ships in 1.26.0: computeNewEntries only surfaces entries
  // with sinceVersion > lastSeen.
  id: "pr-kind-badges",
  sinceVersion: "1.26.0",
  titleKey: "feat_pr_kind_badges_title",
  bodyKey: "feat_pr_kind_badges_body",
} satisfies FeatureAnnouncement;

export default entry;
