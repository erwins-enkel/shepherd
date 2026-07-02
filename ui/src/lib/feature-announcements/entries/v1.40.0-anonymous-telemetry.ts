import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Opt-in anonymous usage telemetry. No targetId — the toggle lives in the
  // Settings modal, which isn't mounted until opened, so there's no stable
  // coachmark anchor. What's-New drawer only.
  id: "anonymous-telemetry",
  sinceVersion: "1.40.0",
  titleKey: "feat_anonymous_telemetry_title",
  bodyKey: "feat_anonymous_telemetry_body",
} satisfies FeatureAnnouncement;

export default entry;
