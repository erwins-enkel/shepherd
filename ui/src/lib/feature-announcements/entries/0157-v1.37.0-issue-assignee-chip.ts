import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Backlog issue rows now show a chip per assignee login, but only when the
  // "mine & unassigned" filter (#824) isn't hiding others' issues — so you can see who
  // already owns a piece of work. No targetId — the chips mount conditionally (filter
  // off + at least one assignee), so there's no persistently-mounted anchor for a
  // coachmark; surface via the What's-New drawer only. v1.36.0 is the latest released
  // tag → ships in 1.37.0.
  id: "issue-assignee-chip",
  sinceVersion: "1.37.0",
  titleKey: "feat_issue_assignee_title",
  bodyKey: "feat_issue_assignee_body",
} satisfies FeatureAnnouncement;

export default entry;
