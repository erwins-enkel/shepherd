import type { FeatureAnnouncement } from "../../feature-announcements";

export default {
  // Phone variant E (docs/design/mobile-herd): read-only status line on top, the gear's menu
  // on the bottom bar's Menu tab, Assist + New as floating buttons. No coachmark target: the
  // only anchor id ("gear-menu") is shared with the desktop gear, which this text doesn't describe.
  id: "phone-thumb-bar",
  sinceVersion: "2.6.0",
  titleKey: "feat_phone_thumb_bar_title",
  bodyKey: "feat_phone_thumb_bar_body",
} satisfies FeatureAnnouncement;
