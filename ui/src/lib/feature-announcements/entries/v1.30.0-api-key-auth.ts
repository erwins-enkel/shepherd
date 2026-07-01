import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the toggle lives in the Settings modal SESSION tab (closed by default),
  // so a coachmark anchor would rarely be mounted — surface via the What's-New drawer only.
  // 1.29.0 is the latest released tag, so this ships in 1.30.0.
  id: "api-key-auth",
  sinceVersion: "1.30.0",
  titleKey: "feat_api_key_auth_title",
  bodyKey: "feat_api_key_auth_body",
} satisfies FeatureAnnouncement;

export default entry;
