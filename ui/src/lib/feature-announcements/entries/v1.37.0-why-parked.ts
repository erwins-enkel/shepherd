import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // "Why parked?" hold-reason line on each held herd card + in the triage drawer (#1008).
  // No targetId: the "Why?" line mounts only when a session is actually held, so there is
  // no persistently-mounted anchor for a coachmark — surface via the What's-New drawer only
  // (same rationale as the two preceding entries). v1.36.0 is the latest released tag →
  // ships in 1.37.0.
  id: "why-parked",
  sinceVersion: "1.37.0",
  titleKey: "feat_why_parked_title",
  bodyKey: "feat_why_parked_body",
} satisfies FeatureAnnouncement;

export default entry;
