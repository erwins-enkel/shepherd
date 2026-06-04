// Catalog driving the What's-New drawer + first-view coachmarks.
//
// CONTRACT: every shipped user-facing feature adds ONE entry here, in the SAME
// PR as the feature — id, sinceVersion (the release it ships in), titleKey/bodyKey
// (added to BOTH ui/messages/en.json and de.json), and an optional targetId paired
// with `use:coachTarget` on the anchor element. Enforced by the
// `scripts/check-feature-catalog.sh` gate (PR-hygiene CI + pre-push).
// See CLAUDE.md → "Feature discovery (REQUIRED for user-facing features)".

export type FeatureAnnouncement = {
  id: string;
  sinceVersion: string;
  titleKey: string;
  bodyKey: string;
  targetId?: string;
};

export const featureAnnouncements: readonly FeatureAnnouncement[] = [
  {
    id: "critic",
    sinceVersion: "1.10.0",
    titleKey: "feat_critic_title",
    bodyKey: "feat_critic_body",
    targetId: "critic",
  },
  {
    id: "auto-address",
    sinceVersion: "1.10.0",
    titleKey: "feat_auto_address_title",
    bodyKey: "feat_auto_address_body",
    targetId: "auto-address",
  },
  {
    id: "learnings",
    sinceVersion: "1.10.0",
    titleKey: "feat_learnings_title",
    bodyKey: "feat_learnings_body",
    targetId: "learnings",
  },
  {
    id: "halt-the-herd",
    sinceVersion: "1.15.0",
    titleKey: "feat_halt_title",
    bodyKey: "feat_halt_body",
  },
];
