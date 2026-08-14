import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Settings → Access mints named machine bearer tokens (#2082) — previously the only way to get
  // one was to read SHEPHERD_TOKEN back out of the server's environment by hand.
  id: "access-tokens",
  sinceVersion: "1.47.0",
  titleKey: "feat_access_tokens_title",
  bodyKey: "feat_access_tokens_body",
} satisfies FeatureAnnouncement;

export default entry;
