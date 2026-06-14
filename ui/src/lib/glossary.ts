// Glossary registry driving inline term tooltips throughout the UI.
//
// CONTRACT: each GlossaryTerm pairs a stable id with i18n keys (termKey /
// bodyKey) that must exist in BOTH ui/messages/en.json and de.json.  Keys
// follow the pattern gloss_<id>_term / gloss_<id>_def.  "internal" terms are
// explained in Shepherd's own words; "external" terms optionally link to a
// Wikipedia article (en + de slugs) for deeper reading.  Do NOT hardcode
// display text here — all user-facing strings live in the message catalogs.

export type GlossaryTerm = {
  id: string;
  kind: "internal" | "external";
  termKey: string;
  bodyKey: string;
  wikipedia?: { en: string; de: string };
};

export const glossary: readonly GlossaryTerm[] = [
  {
    id: "epic",
    kind: "internal",
    termKey: "gloss_epic_term",
    bodyKey: "gloss_epic_def",
  },
  {
    id: "pr",
    kind: "external",
    termKey: "gloss_pr_term",
    bodyKey: "gloss_pr_def",
    wikipedia: {
      en: "Distributed_version_control#Pull_requests",
      de: "Pull-Request",
    },
  },
  {
    id: "ci",
    kind: "external",
    termKey: "gloss_ci_term",
    bodyKey: "gloss_ci_def",
    wikipedia: {
      en: "Continuous_integration",
      de: "Kontinuierliche_Integration",
    },
  },
  {
    id: "critic",
    kind: "internal",
    termKey: "gloss_critic_term",
    bodyKey: "gloss_critic_def",
  },
];

export const glossaryById = new Map<string, GlossaryTerm>(glossary.map((term) => [term.id, term]));
