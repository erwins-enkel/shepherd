import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // Command bar pins (⌥P / long-press), the empty-query Needs-you group and the key footer (#3052).
  id: "commandbar-pins",
  sinceVersion: "2.7.0",
  titleKey: "feat_commandbar_pins_title",
  bodyKey: "feat_commandbar_pins_body",
} satisfies FeatureAnnouncement;
