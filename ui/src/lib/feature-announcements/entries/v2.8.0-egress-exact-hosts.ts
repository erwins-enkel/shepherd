import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the extra allowed hosts live in the repo settings window, not mounted on first view.
  id: "egress-exact-hosts",
  sinceVersion: "2.8.0",
  titleKey: "feat_egress_exact_hosts_title",
  bodyKey: "feat_egress_exact_hosts_body",
} satisfies FeatureAnnouncement;

export default entry;
