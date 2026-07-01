import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Issue #1079: single-operator password → session-cookie auth gating every route + both WS
  // channels (live PTY / activity stream). Logout lives in Settings → Session. Ships in 1.37.0.
  id: "operator-auth",
  sinceVersion: "1.37.0",
  titleKey: "feat_operator_auth_title",
  bodyKey: "feat_operator_auth_body",
} satisfies FeatureAnnouncement;

export default entry;
