import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Codex token telemetry now joins Claude usage in the topbar usage popover. No targetId —
  // the details only mount while the operator has the usage popover/sheet open; surface via
  // the What's-New drawer only. Ships in 1.37.0 alongside the Codex provider path.
  id: "codex-usage-topbar",
  sinceVersion: "1.37.0",
  titleKey: "feat_codex_usage_topbar_title",
  bodyKey: "feat_codex_usage_topbar_body",
} satisfies FeatureAnnouncement;

export default entry;
