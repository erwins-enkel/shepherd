import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // MCP OAuth prompts (Notion, Vercel, …) print an authorize URL Claude word-wraps
  // un-clickably across terminal lines. A banner now surfaces the full URL (read from
  // the transcript) with one-click Open / Copy while the agent waits.
  id: "auth-url-banner",
  sinceVersion: "1.42.0",
  titleKey: "feat_auth_url_banner_title",
  bodyKey: "feat_auth_url_banner_body",
} satisfies FeatureAnnouncement;

export default entry;
