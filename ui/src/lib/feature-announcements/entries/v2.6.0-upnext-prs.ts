import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // PRs in Up Next: open PRs that wait on the operator lead the lens in four bands, each row
  // with one next action. Anchored to the lens button (HerdLensStrip/HerdSegRow).
  id: "upnext-prs",
  sinceVersion: "2.6.0",
  titleKey: "feat_upnext_prs_title",
  bodyKey: "feat_upnext_prs_body",
  targetId: "up-next-lens",
} satisfies FeatureAnnouncement;
