import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the guardrail row only mounts on the Backlog Readiness tab once a
  // project is selected, so a coachmark anchor would usually be unmounted — surface
  // via the What's-New drawer only.
  id: "readiness-dependency-automation",
  sinceVersion: "1.28.0",
  titleKey: "feat_dependency_automation_title",
  bodyKey: "feat_dependency_automation_body",
} satisfies FeatureAnnouncement;

export default entry;
