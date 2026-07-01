import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the EPIC badge is list-repeated (one per epic-seeded session row), but
  // coachTargets keys a single node per id — multiple badges would collide on one key and
  // any row's unmount would delete the shared anchor. There's no single stable element to
  // point at, so surface via the What's-New drawer only (same as epic-runner).
  // v1.27.0 is the latest released tag, so this ships in 1.28.0 — computeNewEntries only
  // surfaces entries with sinceVersion > lastSeen.
  id: "session-epic-badge",
  sinceVersion: "1.28.0",
  titleKey: "feat_session_epic_badge_title",
  bodyKey: "feat_session_epic_badge_body",
} satisfies FeatureAnnouncement;

export default entry;
