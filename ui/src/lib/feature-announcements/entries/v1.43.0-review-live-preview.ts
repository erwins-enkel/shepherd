import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Live "tail -f" preview of what an off-screen review (PR-critic / plan-gate) is doing, shown
  // under the amber review-in-flight banner, plus a visual dim of the idle terminal. targetId
  // points the coachmark at the banner (use:coachTarget={"review-inflight"}).
  id: "review-live-preview",
  sinceVersion: "1.43.0",
  titleKey: "feat_review_live_preview_title",
  bodyKey: "feat_review_live_preview_body",
  targetId: "review-inflight",
} satisfies FeatureAnnouncement;

export default entry;
