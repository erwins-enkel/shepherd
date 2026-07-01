import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // 1.27.0 is already released, so this ships in 1.28.0 (next minor) — else a
  // 1.27.0 entry would never surface for users who already saw the 1.27.x drawer.
  id: "sandbox-profiles",
  sinceVersion: "1.28.0",
  titleKey: "feat_sandbox_title",
  bodyKey: "feat_sandbox_body",
  targetId: "sandbox-profile",
} satisfies FeatureAnnouncement;

export default entry;
