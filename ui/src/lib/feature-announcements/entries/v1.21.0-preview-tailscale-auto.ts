import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: operator-facing infra (zero manual tailscale serve setup); the only
  // UI trace is a degraded Preview badge on failure — surface via the What's-New drawer only.
  // Ships in the next release (1.21.0); 1.20.0 is already tagged so a 1.20.0 entry
  // would never surface (computeNewEntries only shows sinceVersion > lastSeen).
  id: "preview-tailscale-auto",
  sinceVersion: "1.21.0",
  titleKey: "feat_preview_tailscale_title",
  bodyKey: "feat_preview_tailscale_body",
} satisfies FeatureAnnouncement;

export default entry;
