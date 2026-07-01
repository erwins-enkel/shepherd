import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Non-blocking in-terminal banner warning that an in-flight critic / plan-gate
  // review may steer the session on conclusion. Anchored on the banner itself.
  id: "review-inflight-signal",
  sinceVersion: "1.37.0",
  titleKey: "feat_review_inflight_title",
  bodyKey: "feat_review_inflight_body",
  targetId: "review-inflight",
} satisfies FeatureAnnouncement;

export default entry;
