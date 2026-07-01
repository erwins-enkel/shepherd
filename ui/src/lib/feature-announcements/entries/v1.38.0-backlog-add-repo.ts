import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // "+ Add repo" in the Backlog repos panel (New project / Clone / Fork). 1.37.0 is the
  // latest released tag, so this ships in 1.38.0.
  // No targetId — DELIBERATE, despite #1171 asking for a coachmark: the only <Coachmark>
  // host (GitRail) arms exclusively from PILL_FEATURE_IDS and isn't mounted inside the
  // Backlog overlay, so an arbitrary targetId would be a permanently dead anchor (same
  // single-host limitation noted on readiness-analyzer/review-cycles above). Surface via
  // the What's-New drawer only; a real coachmark would need a new arming host (out of scope).
  id: "backlog-add-repo",
  sinceVersion: "1.38.0",
  titleKey: "feat_add_repo_title",
  bodyKey: "feat_add_repo_body",
} satisfies FeatureAnnouncement;

export default entry;
