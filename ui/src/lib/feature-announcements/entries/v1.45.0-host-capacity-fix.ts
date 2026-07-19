import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // The host_capacity DIAGNOSE warning now offers a one-click Fix that set-property's a conservative,
  // host-derived MemoryHigh + CPUQuota on the user-scoped Shepherd unit AND herdr.service (live +
  // persistent, no restart). The check now also inspects herdr, so the green pip durably reflects both.
  // Neutral copy — FeatureAnnouncement has no predicate, so it shows to every upgrading user; the fix
  // itself only surfaces on a user-scoped, tunable systemd host with an unbounded unit.
  id: "host-capacity-fix",
  sinceVersion: "1.45.0",
  titleKey: "feat_host_capacity_fix_title",
  bodyKey: "feat_host_capacity_fix_body",
} satisfies FeatureAnnouncement;

export default entry;
