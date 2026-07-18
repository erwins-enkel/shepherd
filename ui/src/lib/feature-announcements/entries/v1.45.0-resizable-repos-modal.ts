import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the corner handle only mounts while the Repos modal is open, and
  // the modal is closed on first view — so a coachmark anchor would be unmounted.
  // Surface via the What's-New drawer only (same rationale as issue-search /
  // preview-start). The body copy is device-neutral so it reads sensibly in the
  // drawer on mobile/touch, where the resize handles aren't rendered at all.
  id: "resizable-repos-modal",
  sinceVersion: "1.45.0",
  titleKey: "feat_resizable_repos_title",
  bodyKey: "feat_resizable_repos_body",
} satisfies FeatureAnnouncement;

export default entry;
