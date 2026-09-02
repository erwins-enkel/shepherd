import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // A failed issue listing used to report only "couldn't load — maybe a rate limit".
  // The New Task modal and the Issues panel now list the gh transports that actually
  // ran (`gh issue list` on the GraphQL budget, `gh api` on the REST budget) and why
  // each one stopped, with the full gh message on hover.
  id: "issue-load-transports",
  sinceVersion: "1.48.0",
  titleKey: "feat_issue_load_transports_title",
  bodyKey: "feat_issue_load_transports_body",
} satisfies FeatureAnnouncement;

export default entry;
