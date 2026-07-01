import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Doc-agent UI surface (#906, epic #875 P3): a per-repo Backlog trigger button +
  // run/PR status badge + brief run-history popover for the PR-gated doc agent.
  // targetId "doc-agent-trigger" matches use:coachTarget on the DocAgentControl button
  // (desktop). Opt-in (SHEPHERD_DOC_AGENT) so the anchor is absent when disabled.
  // v1.35.0 is the latest released tag → ships in 1.36.0.
  id: "doc-agent-ui",
  sinceVersion: "1.36.0",
  titleKey: "feat_doc_agent_ui_title",
  bodyKey: "feat_doc_agent_ui_body",
  targetId: "doc-agent-trigger",
} satisfies FeatureAnnouncement;

export default entry;
