import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // No targetId: the Rust support surfaces inside the Backlog → Readiness panel
  // (it now scores Cargo crates too) rather than at a single anchor — announce via
  // the What's-New drawer only. 1.41.0 is the latest released tag, so this ships in 1.42.0.
  id: "readiness-rust",
  sinceVersion: "1.42.0",
  titleKey: "feat_readiness_rust_title",
  bodyKey: "feat_readiness_rust_body",
} satisfies FeatureAnnouncement;

export default entry;
