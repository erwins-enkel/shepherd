import { m } from "#lib/paraglide/messages.js";
import { keyedMessages } from "#lib/keyed-messages.js";

// Resolves a feature announcement's titleKey/bodyKey/ctaLabelKey. Kept out of
// feature-announcements.ts (eager) so this copy loads with its only consumers,
// the lazy What's-New drawer and coachmark (#3242). Only these key families are
// bundled, so a new entry's keys must use the `feat_` prefix; feature-gate.test.ts
// fails on any catalog key this lookup can't resolve.
export const featureMessage = keyedMessages(m, [
  "feat_",
  "feature_",
  "pairing_feature_",
  "topbar_codex_reset_feature_",
]);
