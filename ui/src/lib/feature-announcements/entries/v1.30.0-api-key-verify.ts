import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the Verify button only mounts in the Settings modal SESSION tab
  // (closed by default) and only once an API key is configured, so a coachmark
  // anchor would rarely be mounted — surface via the What's-New drawer only.
  id: "api-key-verify",
  sinceVersion: "1.30.0",
  titleKey: "feat_api_key_verify_title",
  bodyKey: "feat_api_key_verify_body",
} satisfies FeatureAnnouncement;

export default entry;
