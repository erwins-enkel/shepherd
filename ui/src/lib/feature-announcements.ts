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
];
