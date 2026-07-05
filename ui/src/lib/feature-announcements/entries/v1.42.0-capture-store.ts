import type { FeatureAnnouncement } from "../../feature-announcements";
import { CAPTURE_EXTENSION_URL } from "../../build-info";

// The Shepherd Capture extension is now published on the Chrome Web Store. A new
// entry (rather than editing the older v1.15.0 one) is required so this re-surfaces
// to existing users — feature-gate only shows sinceVersion > the user's lastSeen.
const entry = {
  id: "capture-extension-store",
  sinceVersion: "1.42.0",
  titleKey: "feature_capture_store_title",
  bodyKey: "feature_capture_store_body",
  ctaUrl: CAPTURE_EXTENSION_URL,
  ctaLabelKey: "feature_capture_store_cta",
} satisfies FeatureAnnouncement;

export default entry;
